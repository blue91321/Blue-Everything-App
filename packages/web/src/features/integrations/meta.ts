import type { FeatureMeta } from '../index';

// After the vault (50), which is the other feature-owned tab. Settings pins
// itself to the foot of the drawer regardless, so a growing list of features
// never pushes it out of reach.
export const meta: FeatureMeta = { id: 'integrations', label: 'Connections', glyph: '🔌', order: 55 };
