// Allowed module edges, from SHARED-BOUNDARIES 3.2 (BD-02). A module may import a module
// listed for it here, or any module in a lower layer unless the rule says otherwise below.
// Adding an edge needs a design reason (HEAAA-13) and a reviewer; do not widen it to make lint pass.
export const LAYERS = {
  L1: ['audit', 'integration-core', 'organisation', 'identity', 'notifications'],
  L2: ['patient', 'documents'],
  L3: ['scheduling', 'calendar-sync', 'telehealth', 'clinical', 'messaging', 'privacy'],
  L4: ['prescribing', 'pharmacy-network', 'billing', 'labs'],
  L5: ['reporting'],
  // Admin routes (BE-24): composes audit and integration-core behind the admin realm; nothing imports it (INT04-F04).
  L6: ['admin-routes'],
};

const layerOf = Object.fromEntries(
  Object.entries(LAYERS).flatMap(([layer, mods]) => mods.map((m) => [m, Number(layer.slice(1))])),
);

// Same-layer edges drawn in the diagram (importer -> allowed targets).
const SAME_LAYER = {
  'integration-core': ['audit'],
  organisation: ['audit'],
  identity: ['organisation', 'audit', 'integration-core'],
  notifications: ['identity', 'integration-core', 'audit'],
  documents: ['patient'],
  'calendar-sync': ['scheduling'],
  telehealth: ['scheduling'],
  clinical: ['scheduling', 'documents'],
  'pharmacy-network': ['prescribing'],
  labs: ['clinical'],
};
// Registration edges (dotted): these modules import only privacy's registration interface.
const REGISTRATION = {
  scheduling: ['privacy'],
  clinical: ['privacy'],
  messaging: ['privacy'],
  telehealth: ['privacy'],
};

export const MODULES = Object.keys(layerOf);

export function isAllowedEdge(from, to) {
  if (from === to) return true;
  const lf = layerOf[from];
  const lt = layerOf[to];
  if (lf === undefined || lt === undefined) return false;
  if (to === 'reporting') return false; // nothing depends on reporting (rule 4)
  if (from === 'reporting') return true; // reads published views of any module (rule 4)
  if (lt < lf) return true;
  if (lt === lf)
    return (SAME_LAYER[from] ?? []).includes(to) || (REGISTRATION[from] ?? []).includes(to);
  return false;
}
