/** SCN-006 uses this fixed set of existing tests in a single confined process. */
export const OFFLINE_SUITE_V1_TESTS = [
  'eventlog-readonly-replay.test',
  'evidence-identity.test',
  'graph-identity-parity.test',
  'improvementFieldNormalization.test',
  'improvementFieldProjection.test',
  'navigator-inventory-parity.test',
  'navigator-physical-inventory.test',
  'path-grammar.test',
  'project-profile-hash.test',
  'proof-verdict-protocol.test',
  'recognizer-identity.test',
  'status-contract.test',
  'status-seal.test',
] as const;
