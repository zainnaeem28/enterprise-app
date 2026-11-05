import path from 'node:path';

// Import-boundary rule between API modules (ARCHITECTURE 4, SHARED-BOUNDARIES 3.2 / BD-02).
// Modules live in apps/api/src/modules/<module>/. An import that resolves into another module
// must follow an allowed (downward or drawn) edge. Cross-module imports must also go through the
// module's public entry (index), never its internals.
import { isAllowedEdge, MODULES } from '../module-graph.mjs';

const MODULE_ROOT = /[\\/]apps[\\/]api[\\/]src[\\/]modules[\\/]([^\\/]+)(?:[\\/](.*))?$/;

function moduleOf(file) {
  const m = MODULE_ROOT.exec(file);
  return m ? { name: m[1], rest: m[2] ?? '' } : null;
}

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      unknownModule: 'Module "{{name}}" is not in the module graph (eslint/module-graph.mjs).',
      upward:
        'Import of module "{{to}}" from module "{{from}}" is not an allowed edge (BD-02: downwards only).',
      internals: 'Import reaches into module "{{to}}" internals; use its public index.',
    },
  },
  create(context) {
    const filename = context.filename;
    const self = moduleOf(filename);
    if (!self) return {};
    function check(node, spec) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) return;
      const target = path.resolve(path.dirname(filename), spec);
      const other = moduleOf(target);
      if (!other || other.name === self.name) return;
      for (const n of [self.name, other.name]) {
        if (!MODULES.includes(n))
          return context.report({ node, messageId: 'unknownModule', data: { name: n } });
      }
      if (!isAllowedEdge(self.name, other.name)) {
        return context.report({
          node,
          messageId: 'upward',
          data: { from: self.name, to: other.name },
        });
      }
      if (other.rest && !/^index(\.[cm]?[jt]s)?$/.test(other.rest)) {
        context.report({ node, messageId: 'internals', data: { to: other.name } });
      }
    }
    return {
      ImportDeclaration: (n) => check(n, n.source.value),
      ExportAllDeclaration: (n) => n.source && check(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
      ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
    };
  },
};
