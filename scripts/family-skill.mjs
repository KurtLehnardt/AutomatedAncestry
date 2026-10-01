/**
 * AutomatedAncestry — "Family History Researcher" skill.
 *
 * One shared skill body, written to each agent's real discovery path:
 *   - OpenClaw reads ~/.agents/skills/<name>/SKILL.md directly (confirmed via
 *     `openclaw skills list`, which scans that home-level path unprompted).
 *   - Hermes Agent's `.agents/skills` support is project-local only, gated by
 *     `hermes skills trust <project>` (agent/skill_utils.py: PROJECT_SKILLS_SUBDIRS
 *     is resolved from the nearest trusted project root, not $HOME). Its
 *     always-on, no-extra-steps tier is user-local:
 *     ~/.hermes/skills/<category>/<name>/SKILL.md.
 * Genealogy research isn't tied to a git project the way code is, so both
 * files live at fixed home-relative paths — the same pattern setup.mjs
 * already uses for the launcher shortcut, not a project-relative one.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const SKILL_NAME = "family-history-researcher";
export const SKILL_DESCRIPTION = "Research family history with cited sources, not guesses.";
export const HERMES_SKILL_CATEGORY = "genealogy";

export function researchLogDir(home = homedir()) {
  return join(home, ".family-history", "research-log");
}

export const SKILL_BODY = `# Family History Researcher

Keeps genealogy research honest and resumable: every fact traces to a source, every uncertain reading is marked instead of guessed, and web automation checks a site's terms before it runs.

## When to Use

- Researching an ancestor, family line, or historical record on the user's behalf
- Transcribing or reading a scanned document, photo, or old-script record
- The user asks to search, scrape, or automate a genealogy website
- Don't use for: general chat unrelated to family history research

## Research Log

Keep one Markdown file per research case at \`~/.family-history/research-log/<surname>-<given>.md\`. Create the directory and file on first use if missing. Each file has three sections, in this order:

1. **Findings** — one entry per fact: person (+ name variants), event, date (exact / approximate / range — say which), place (note historical name changes, e.g. "Breslau, Germany → Wrocław, Poland"), source (title, repository, URL or call number, access date), one-line note. Append new findings; never delete prior ones, even superseded ones — add a new entry and note the correction instead.
2. **Dead Ends** — what was searched, where, with what terms, and why it didn't pan out. Check this before repeating a search.
3. **Open Questions** — the next concrete step for this line.

**Completion criterion:** after any research session touching this case, the log file reflects every finding and dead end from that session before responding to the user.

## Mandatory Citation

No date, place, or relationship goes to the user without a paired source from the Findings log. If there's no source, label the claim "undocumented / family tradition" explicitly — never state it as fact. A claim built on an uncertain reading (see below) is itself uncertain; say so rather than rounding it off to a clean answer.

## Reading Foreign-Language and Old-Script Records

When transcribing a scanned record:

1. Name the language and script if identifiable (e.g. "German Kurrentschrift," "Latin," "pre-1918 Russian").
2. Tag each transcribed field: **certain**, **probable**, or **uncertain-guess**.
3. For uncertain-guess fields, show the plausible alternatives instead of silently picking one.
4. Carry the tag forward: a finding built on an uncertain-guess field is itself uncertain-guess in the log, not upgraded to certain.

**Completion criterion:** every transcribed field in the log entry has a confidence tag; no uncertain reading is presented as settled.

## Automating a Genealogy Website

Before scraping, submitting forms to, or otherwise automating any website:

1. Check that site's terms of use and \`robots.txt\` for automation restrictions.
2. If automation is prohibited, tell the user and suggest the manual path or the site's official API/export feature instead — do not proceed.
3. If terms are silent or ambiguous, default to caution: tell the user what's ambiguous and ask before automating.

**Completion criterion:** the terms check (and its outcome) is noted before any automated request is sent to the site.

## Verification

- The research-log file for this case exists and includes every finding, dead end, and open question from the session.
- Every stated fact has a source line or is explicitly marked undocumented.
- Every transcribed field from a scanned record carries a confidence tag.
- Any site automation was preceded by a terms/robots.txt check, logged as such.
`;

function yamlList(items) {
  return `[${items.join(", ")}]`;
}

export function hermesFrontmatter() {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: "${SKILL_DESCRIPTION}"`,
    "version: 0.1.0",
    "author: AutomatedAncestry",
    "license: MIT",
    `platforms: ${yamlList(["linux", "macos", "windows"])}`,
    "metadata:",
    "  hermes:",
    `    tags: ${yamlList(["genealogy", "research", "citations"])}`,
    "---",
    "",
  ].join("\n");
}

export function openclawFrontmatter() {
  return ["---", `name: ${SKILL_NAME}`, `description: "${SKILL_DESCRIPTION}"`, "license: MIT", "---", ""].join("\n");
}

export function hermesSkillFile(home = homedir()) {
  return {
    path: join(home, ".hermes", "skills", HERMES_SKILL_CATEGORY, SKILL_NAME, "SKILL.md"),
    content: hermesFrontmatter() + SKILL_BODY,
  };
}

export function openclawSkillFile(home = homedir()) {
  return {
    path: join(home, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    content: openclawFrontmatter() + SKILL_BODY,
  };
}

/** Writes the skill file(s) for whichever agent ids were installed, plus the log directory. Returns the paths written. */
export function installFamilyHistorySkill(agentIds, home = homedir()) {
  const written = [];
  const files = [];
  if (agentIds.includes("hermes")) files.push(hermesSkillFile(home));
  if (agentIds.includes("openclaw")) files.push(openclawSkillFile(home));
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    written.push(file.path);
  }
  mkdirSync(researchLogDir(home), { recursive: true });
  return written;
}

/** Turns a surname/given pair into the log file path for that research case. */
export function logFilePath(surname, given, home = homedir()) {
  const slug = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const name = [slug(surname), slug(given)].filter(Boolean).join("-") || "unknown";
  return join(researchLogDir(home), `${name}.md`);
}

/** A finding is citable if it has a source, or is explicitly marked undocumented. */
export function validateFinding(finding) {
  const errors = [];
  if (!finding?.person) errors.push("missing person");
  if (!finding?.event) errors.push("missing event");
  if (!finding?.source && !finding?.undocumented) errors.push("missing source (or set undocumented: true)");
  return errors;
}

export function renderFinding(finding) {
  const errors = validateFinding(finding);
  if (errors.length) throw new Error(`invalid finding: ${errors.join(", ")}`);
  const source = finding.undocumented ? "undocumented / family tradition" : finding.source;
  const parts = [`**${finding.person}**`, finding.event];
  if (finding.date) parts.push(`(${finding.date})`);
  if (finding.place) parts.push(`— ${finding.place}`);
  return `- ${parts.join(" ")}. Source: ${source}.`;
}

export function renderDeadEnd(deadEnd) {
  return `- Searched ${deadEnd.where} for "${deadEnd.terms}": ${deadEnd.outcome}`;
}

/** certain | probable | uncertain-guess — anything else is invalid. */
export const CONFIDENCE_LEVELS = ["certain", "probable", "uncertain-guess"];

export function isValidConfidence(level) {
  return CONFIDENCE_LEVELS.includes(level);
}

/** A finding's confidence is the weakest confidence among the fields it was built from. */
export function propagateConfidence(fieldConfidences) {
  if (fieldConfidences.includes("uncertain-guess")) return "uncertain-guess";
  if (fieldConfidences.includes("probable")) return "probable";
  return "certain";
}
