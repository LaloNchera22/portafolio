// Helpers shared by the pure game rules.
export function clone(o) { return JSON.parse(JSON.stringify(o)); }
export function pick(a) { return a[(Math.random() * a.length) | 0]; }
