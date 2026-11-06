export function SkipLink({ targetId, children }: { targetId: string; children: string }) {
  return (
    <a className="ehr-skip-link" href={`#${targetId}`}>
      {children}
    </a>
  );
}
