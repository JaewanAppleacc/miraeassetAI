// Turn N4.16: pure functions for applying Turn N4.13's Strategy A delta
// (already Owner-approved per Turn N4.15) onto a NEW v0.3 candidate
// assignment, without ever mutating the v0.2/v0.1 records passed in. These
// functions never read or write a file -- callers own all I/O -- so every
// invariant here can be proven with plain synthetic fixtures.

// Applies split-dimension delta rows to Candidate Pool records, returning a
// brand-new array (input records are never mutated). Throws if a delta row
// targets an assignment_id absent from poolRecords, or if a delta row's
// `from` does not match the record's CURRENT planned_split (protects against
// applying a delta computed against a different base state).
export function applyPoolSplitDelta({ poolRecords, deltaRows }) {
  const splitDelta = deltaRows.filter((r) => r.dimension === "split");
  const byId = new Map(poolRecords.map((r) => [r.assignment_id, r]));
  for (const move of splitDelta) {
    const record = byId.get(move.assignment_id);
    if (!record) throw new Error(`applyPoolSplitDelta: assignment_id "${move.assignment_id}" not found in poolRecords`);
    if (record.planned_split !== move.from) {
      throw new Error(`applyPoolSplitDelta: assignment_id "${move.assignment_id}" current planned_split "${record.planned_split}" does not match delta's expected "from" value "${move.from}"`);
    }
  }
  const moveById = new Map(splitDelta.map((m) => [m.assignment_id, m]));
  return poolRecords.map((r) => {
    const move = moveById.get(r.assignment_id);
    return move ? { ...r, planned_split: move.to } : { ...r };
  });
}

// Applies author-dimension delta rows to Author allocation records, same
// non-mutating / from-value-checked contract as applyPoolSplitDelta.
export function applyAuthorDelta({ authorRows, deltaRows }) {
  const authorDelta = deltaRows.filter((r) => r.dimension === "author");
  const byId = new Map(authorRows.map((r) => [r.assignment_id, r]));
  for (const move of authorDelta) {
    const record = byId.get(move.assignment_id);
    if (!record) throw new Error(`applyAuthorDelta: assignment_id "${move.assignment_id}" not found in authorRows`);
    if (record.author_allocation !== move.from) {
      throw new Error(`applyAuthorDelta: assignment_id "${move.assignment_id}" current author_allocation "${record.author_allocation}" does not match delta's expected "from" value "${move.from}"`);
    }
  }
  const moveById = new Map(authorDelta.map((m) => [m.assignment_id, m]));
  return authorRows.map((r) => {
    const move = moveById.get(r.assignment_id);
    return move ? { ...r, author_allocation: move.to } : { ...r };
  });
}

// Generic, field-level diff between two same-length, same-ID-set record
// arrays. Returns, per assignment_id, exactly which top-level fields differ
// (by JSON deep-equality) -- used to PROVE that applying a delta touched
// ONLY the fields/ids it claimed to, and nothing else was silently mutated.
export function diffRecordsByAssignmentId({ before, after }) {
  const beforeById = new Map(before.map((r) => [r.assignment_id, r]));
  const afterById = new Map(after.map((r) => [r.assignment_id, r]));
  const beforeIds = new Set(beforeById.keys());
  const afterIds = new Set(afterById.keys());
  const addedIds = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removedIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const changes = [];
  for (const id of beforeIds) {
    if (!afterIds.has(id)) continue;
    const b = beforeById.get(id);
    const a = afterById.get(id);
    const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
    const changedFields = [...fields].filter((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f])).sort();
    if (changedFields.length > 0) changes.push({ assignment_id: id, changed_fields: changedFields });
  }
  return Object.freeze({
    added_ids: addedIds,
    removed_ids: removedIds,
    changed: changes.sort((x, y) => x.assignment_id.localeCompare(y.assignment_id)),
    changed_id_count: changes.length,
  });
}

// Verifies a diff result is EXACTLY the expected shape: no rows added or
// removed, exactly `expectedChangedIds` changed, and every changed row's
// changed_fields is a subset of `allowedFields`.
export function verifyDeltaApplicationScope({ diff, expectedChangedIds, allowedFields }) {
  const violations = [];
  if (diff.added_ids.length > 0) violations.push({ type: "ROWS_ADDED", ids: diff.added_ids });
  if (diff.removed_ids.length > 0) violations.push({ type: "ROWS_REMOVED", ids: diff.removed_ids });
  const expectedSet = new Set(expectedChangedIds);
  const actualSet = new Set(diff.changed.map((c) => c.assignment_id));
  const unexpectedlyChanged = [...actualSet].filter((id) => !expectedSet.has(id));
  const expectedButUnchanged = [...expectedSet].filter((id) => !actualSet.has(id));
  if (unexpectedlyChanged.length > 0) violations.push({ type: "UNEXPECTED_ID_CHANGED", ids: unexpectedlyChanged.sort() });
  if (expectedButUnchanged.length > 0) violations.push({ type: "EXPECTED_ID_NOT_CHANGED", ids: expectedButUnchanged.sort() });
  const allowedSet = new Set(allowedFields);
  for (const c of diff.changed) {
    const disallowed = c.changed_fields.filter((f) => !allowedSet.has(f));
    if (disallowed.length > 0) violations.push({ type: "DISALLOWED_FIELD_CHANGED", assignment_id: c.assignment_id, fields: disallowed });
  }
  return Object.freeze({ ok: violations.length === 0, violations });
}
