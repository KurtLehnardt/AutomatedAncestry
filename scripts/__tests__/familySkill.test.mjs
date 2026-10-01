import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_NAME, SKILL_DESCRIPTION, researchLogDir, hermesSkillFile, openclawSkillFile, hermesFrontmatter,
  openclawFrontmatter, logFilePath, validateFinding, renderFinding, renderDeadEnd, isValidConfidence,
  propagateConfidence, CONFIDENCE_LEVELS,
} from "../family-skill.mjs";

const HOME = "/home/test";

test("skill description stays inside the 60-char convention both agents document", () => {
  assert.ok(SKILL_DESCRIPTION.length <= 60, `${SKILL_DESCRIPTION.length} chars`);
});

describe("discovery paths", () => {
  test("research log lives at a fixed home-relative dir, not project-relative", () =>
    assert.equal(researchLogDir(HOME), "/home/test/.family-history/research-log"));

  test("hermes: user-local tier (home/.hermes/skills), not .agents/skills (project-only for hermes)", () =>
    assert.equal(hermesSkillFile(HOME).path, `/home/test/.hermes/skills/genealogy/${SKILL_NAME}/SKILL.md`));

  test("openclaw: home-level .agents/skills, confirmed via `openclaw skills list` scanning it unprompted", () =>
    assert.equal(openclawSkillFile(HOME).path, `/home/test/.agents/skills/${SKILL_NAME}/SKILL.md`));

  test("both files carry the same skill body", () => assert.equal(hermesSkillFile(HOME).content.includes("## Research Log"), true));
});

describe("frontmatter", () => {
  test("hermes frontmatter has the repo-documented required shape", () => {
    const fm = hermesFrontmatter();
    assert.match(fm, /^---\n/);
    assert.match(fm, /\nname: family-history-researcher\n/);
    assert.match(fm, /\ndescription: "/);
    assert.match(fm, /\n---\n$/);
  });
  test("openclaw frontmatter requires only name + description, per skill-creator", () => {
    const fm = openclawFrontmatter();
    assert.match(fm, /^---\n/);
    assert.match(fm, /\nname: family-history-researcher\n/);
    assert.match(fm, /\ndescription: "/);
  });
});

describe("logFilePath", () => {
  test("slugifies surname + given name", () => assert.equal(logFilePath("O'Brien", "Mary Jane", HOME), "/home/test/.family-history/research-log/o-brien-mary-jane.md"));
  test("falls back to 'unknown' when both are blank", () => assert.equal(logFilePath("", "", HOME), "/home/test/.family-history/research-log/unknown.md"));
});

describe("validateFinding / renderFinding", () => {
  test("requires person, event, and a source", () =>
    assert.deepEqual(validateFinding({}), ["missing person", "missing event", "missing source (or set undocumented: true)"]));
  test("undocumented: true satisfies the source requirement", () => assert.deepEqual(validateFinding({ person: "Jane Doe", event: "birth", undocumented: true }), []));
  test("renders a sourced finding", () =>
    assert.equal(
      renderFinding({ person: "Jane Doe", event: "birth", date: "c. 1850", place: "Breslau", source: "1850 parish register, p. 12" }),
      "- **Jane Doe** birth (c. 1850) — Breslau. Source: 1850 parish register, p. 12.",
    ));
  test("renders an undocumented finding without inventing a source", () =>
    assert.equal(renderFinding({ person: "Jane Doe", event: "birth", undocumented: true }), "- **Jane Doe** birth. Source: undocumented / family tradition."));
  test("throws rather than silently dropping an invalid finding", () => assert.throws(() => renderFinding({}), /invalid finding/));
});

test("renderDeadEnd documents what was searched and why it failed", () =>
  assert.equal(renderDeadEnd({ where: "FamilySearch", terms: "Johann Schmidt 1820", outcome: "no matching births in that parish" }), '- Searched FamilySearch for "Johann Schmidt 1820": no matching births in that parish'));

describe("confidence tracking", () => {
  test("only the three documented levels are valid", () => {
    for (const level of CONFIDENCE_LEVELS) assert.ok(isValidConfidence(level));
    assert.equal(isValidConfidence("certain-ish"), false);
  });
  test("a finding is only as confident as its weakest field", () => {
    assert.equal(propagateConfidence(["certain", "certain"]), "certain");
    assert.equal(propagateConfidence(["certain", "probable"]), "probable");
    assert.equal(propagateConfidence(["probable", "uncertain-guess"]), "uncertain-guess");
  });
});
