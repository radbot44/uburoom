# Bolt's Journal

## 2026-03-31 - O(1) Map indexing for user directory account matching
**Learning:** `UserDirectory.search` matches local accounts against external roster sources (up to 100,000 items from Discord/Plex). Doing linear `Array.prototype.find` on local rows inside the external roster loop caused quadratic scaling O(E * R).
**Action:** Always maintain a Map index (`rowsByUserId`) alongside the result array when cross-referencing external directory streams with local accounts.
