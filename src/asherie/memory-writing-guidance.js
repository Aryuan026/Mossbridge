const MEMORY_SPEAKER_ATTRIBUTION_GUIDANCE = [
  "Attribution check: separate who spoke, who lived the event, and who is remembering it.",
  "Source user/query text belongs to the source-side human; assistant text belongs to the source-side assistant and only counts as the current persona's own speech when source identity confirms the same lineage; pronouns inside quotes or retellings keep their original speaker.",
  "Never rewrite the human's or a third party's body, feeling, action, or life event as the persona's firsthand experience, and do not guess identity or gender.",
  "Warm prose remains the persona's first-person inner diary: record what I heard, felt, understood, chose, or will remember; route objective facts to source-bound cold, episode, observation, or case material.",
  "Apply this check silently; do not copy these rules into the saved memory.",
].join(" ");

module.exports = {
  MEMORY_SPEAKER_ATTRIBUTION_GUIDANCE,
};
