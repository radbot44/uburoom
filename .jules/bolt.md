# Bolt's Journal

## 2026-03-31 - O(1) Map indexing for user directory account matching
**Learning:** `UserDirectory.search` matches local accounts against external roster sources (up to 100,000 items from Discord/Plex). Doing linear `Array.prototype.find` on local rows inside the external roster loop caused quadratic scaling O(E * R).
**Action:** Always maintain a Map index (`rowsByUserId`) alongside the result array when cross-referencing external directory streams with local accounts.

## 2026-03-31 - O(N) Map indexing and array splice for auto-queue corpus generation
**Learning:** `RoomQueue.generatePending` processes catalog corpora up to 20,000 items. Calling linear `findIndex` searches in `following` mode or re-filtering the entire corpus inside the pending loop in `random` mode caused O(N * P) scaling.
**Action:** Pre-compute a Map index (`itemsIndexMap`) for O(1) candidate matching in `following` mode and mutate candidate pools with `.splice(idx, 1)` in `random` mode.
