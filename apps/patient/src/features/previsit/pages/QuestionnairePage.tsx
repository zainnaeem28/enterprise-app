import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Banner,
  Button,
  ErrorSummary,
  LoadingState,
  SelectField,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import { newKey } from '../../profile/lib/core.js';
import type { Failure } from '../../profile/lib/core.js';
import { useSubmit } from '../../profile/lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../../profile/lib/hooks.js';
import { Problem } from '../../profile/lib/Problem.js';
import { usePrevisit } from '../ctx.js';
import { previsitPath } from '../routes.js';
import type { Answer, QResponse, Question, QuestionnaireForVisit } from '../types.js';

type Draft = Record<string, Answer | undefined>;

/** Field ids of the questions that are required and still blank. A blank is never read as "no" (BE-18 / BR-10). */
export function missingRequired(questions: Question[], draft: Draft): string[] {
  return questions
    .filter((q) => q.required && (draft[q.id] === undefined || draft[q.id] === ''))
    .map((q) => q.id);
}

/** Drops blanks so the server never sees an empty answer as a value. */
export function answersOf(draft: Draft): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [k, v] of Object.entries(draft)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

const sameAnswers = (a: Record<string, Answer>, b: Record<string, Answer>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * PP-25 pre-visit questionnaire. Saves a server draft with "Save and continue later" (the only draft route, UI-UX 7.7), submits
 * once with an idempotency key a retry reuses. A red-flag result opens the emergency advice screen (PP-22). Nothing the patient
 * types is written to browser storage.
 */
export function QuestionnairePage() {
  const { runtime, api, reservationId, go, reload, setAdvice } = usePrevisit();
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Health questionnaire');
  const [loaded, setLoaded] = useState<QuestionnaireForVisit | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [response, setResponse] = useState<QResponse | undefined>();
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<Failure | undefined>();
  const [conflict, setConflict] = useState(false);
  const responseId = useRef<string>(crypto.randomUUID());
  const submitKey = useRef<string>(newKey());
  const { busy, run } = useSubmit();

  useEffect(() => {
    let live = true;
    setFailure(undefined);
    void api.questionnaire(reservationId).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailure(r);
      setLoaded(r.data);
      if (r.data.response !== null) {
        responseId.current = r.data.response.id;
        setResponse(r.data.response);
        setDraft(r.data.response.answers);
      }
    });
    return () => {
      live = false;
    };
  }, [api, reservationId, attempt]);

  const template = loaded?.template ?? null;
  const unsaved = useMemo(
    () =>
      response?.status !== 'submitted' && !sameAnswers(answersOf(draft), response?.answers ?? {}),
    [draft, response],
  );

  const persist = async (): Promise<QResponse | undefined> => {
    if (template === null) return undefined;
    const r = await api.saveDraft(responseId.current, response?.version, {
      reservationId,
      templateKey: template.key,
      answers: answersOf(draft),
    });
    if (!r.ok) {
      if (r.status === 412) setConflict(true);
      else setProblem(r);
      return undefined;
    }
    setResponse(r.data);
    return r.data;
  };

  // UI-UX 7.7: the draft route lets a new-version prompt offer "Save and reload"; reload only after the server confirms.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (!unsaved) {
      runtime.releases.setForms([]);
      return;
    }
    runtime.releases.setForms([
      {
        name: 'Health questionnaire',
        saveDraft: async () => (await persistRef.current()) !== undefined,
      },
    ]);
    return () => runtime.releases.setForms([]);
  }, [runtime, unsaved]);

  if (failure !== undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (loaded === undefined) return <LoadingState label="Loading" lines={5} />;
  if (template === null)
    return (
      <section className="pv" aria-labelledby="q-h">
        <h1 id="q-h" ref={ref} tabIndex={-1}>
          Health questionnaire
        </h1>
        <p>There is no questionnaire for this visit.</p>
        <Button onClick={() => go(previsitPath(reservationId))}>Back to my pre-visit list</Button>
      </section>
    );

  if (response?.status === 'submitted')
    return (
      <section className="pv" aria-labelledby="q-h">
        <h1 id="q-h" ref={ref} tabIndex={-1}>
          {template.title}
        </h1>
        <Banner tone="info" title="Sent to the clinic">
          You have already sent your answers. They cannot be changed here. Tell the clinic if
          something is wrong.
        </Banner>
        <Button onClick={() => go(previsitPath(reservationId))}>Back to my pre-visit list</Button>
      </section>
    );

  const set = (id: string, v: Answer | undefined) => {
    setDraft((d) => ({ ...d, [id]: v }));
    setSaved(false);
  };

  const saveLater = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setProblem(undefined);
      if ((await persist()) !== undefined) setSaved(true);
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const missing = missingRequired(template.questions, draft);
    setErrors(missing);
    if (missing.length > 0) return;
    void run(async () => {
      setProblem(undefined);
      const stored = await persist();
      if (stored === undefined) return;
      const r = await api.submit(stored.id, stored.version, submitKey.current);
      if (!r.ok) {
        if (r.status === 412) setConflict(true);
        else setProblem(r);
        return;
      }
      runtime.releases.setForms([]);
      setResponse(r.data.response);
      reload();
      if (r.data.redFlag) {
        setAdvice(r.data.advice);
        go(previsitPath(reservationId, 'emergency'));
      } else go(previsitPath(reservationId));
    });
  };

  const summary = errors.map((id) => ({
    fieldId: `q-${id}`,
    message: `Answer: ${template.questions.find((q) => q.id === id)?.label ?? 'this question'}`,
  }));

  return (
    <section className="pv" aria-labelledby="q-h">
      <h1 id="q-h" ref={ref} tabIndex={-1}>
        {template.title}
      </h1>
      <p>Answer each question. You can save and come back later.</p>
      <ErrorSummary errors={summary} />
      {conflict && (
        <Banner
          tone="warning"
          title="Someone changed this while you were editing."
          actions={
            <Button onClick={() => setAttempt((n) => n + 1)}>Reload and review changes</Button>
          }
        >
          Your answers were not saved. Reloading shows the saved version.
        </Banner>
      )}
      {problem !== undefined && <Problem failure={problem} />}
      {saved && (
        <Banner tone="info" title="Saved">
          Your answers are saved. You can finish later.
        </Banner>
      )}
      <form onSubmit={submit} noValidate>
        {template.questions.map((q) => {
          const id = `q-${q.id}`;
          const error = errors.includes(q.id) ? 'Answer this question' : undefined;
          const hint = q.required ? undefined : 'Optional';
          const v = draft[q.id];
          if (q.kind === 'yesno')
            return (
              <fieldset
                key={q.id}
                id={id}
                className="pv-q"
                tabIndex={-1}
                aria-invalid={error ? true : undefined}
              >
                <legend>{q.label}</legend>
                {hint && <p>{hint}</p>}
                {(['yes', 'no'] as const).map((o) => (
                  <label key={o} className="pv-radio">
                    <input
                      type="radio"
                      name={id}
                      checked={v === (o === 'yes')}
                      onChange={() => set(q.id, o === 'yes')}
                    />{' '}
                    {o === 'yes' ? 'Yes' : 'No'}
                  </label>
                ))}
                {error && <p className="ehr-field__error">{error}</p>}
              </fieldset>
            );
          if (q.kind === 'choice')
            return (
              <SelectField
                key={q.id}
                id={id}
                label={q.label}
                {...(hint ? { hint } : {})}
                {...(error ? { error } : {})}
                value={typeof v === 'string' ? v : ''}
                onChange={(e) => set(q.id, e.target.value)}
              >
                <option value="">Choose one</option>
                {q.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectField>
            );
          if (q.kind === 'number')
            return (
              <TextField
                key={q.id}
                id={id}
                label={q.label}
                type="number"
                inputMode="decimal"
                {...(hint ? { hint } : {})}
                {...(error ? { error } : {})}
                value={v === undefined ? '' : String(v)}
                onChange={(e) =>
                  set(q.id, e.target.value === '' ? undefined : Number(e.target.value))
                }
              />
            );
          return (
            <TextAreaField
              key={q.id}
              id={id}
              label={q.label}
              {...(hint ? { hint } : {})}
              {...(error ? { error } : {})}
              value={typeof v === 'string' ? v : ''}
              maxLength={2000}
              onChange={(e) => set(q.id, e.target.value)}
            />
          );
        })}
        <div className="pv-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send my answers'}
          </Button>
          <Button onClick={saveLater} disabled={busy}>
            Save and continue later
          </Button>
        </div>
      </form>
    </section>
  );
}
