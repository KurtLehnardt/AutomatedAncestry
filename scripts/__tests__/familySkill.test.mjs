import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_NAME, SKILL_DESCRIPTION, researchLogDir, hermesSkillFile, openclawSkillFile, hermesFrontmatter,
  openclawFrontmatter, logFilePath, validateFinding, renderFinding, renderDeadEnd, isValidConfidence,
  propagateConfidence, CONFIDENCE_LEVELS, SOUL_BODY, HERMES_SOUL_PROFILE, hermesProfileCreateCommand,
  hermesProfileDir, hermesSoulFile, openclawSoulFile,
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

describe("SOUL.md persona", () => {
  test("covers the categories OpenClaw's own docs say SOUL.md is for (tone, opinions, boundaries), not data/records", () => {
    for (const heading of ["## Who you are", "## Opinions worth having", "## How you talk", "## Humor", "## Bluntness", "## Hard boundaries"]) {
      assert.ok(SOUL_BODY.includes(heading), `missing ${heading}`);
    }
  });
  test("encodes the same hard constraints as the skill: citation, confidence, ToS, FamilySearch confirmation", () => {
    assert.match(SOUL_BODY, /No source, no claim/);
    assert.match(SOUL_BODY, /uncertain-guess reading .* stays uncertain-guess/);
    assert.match(SOUL_BODY, /FamilySearch.*Ancestry.*prohibit automated\/bot access/s);
    assert.match(SOUL_BODY, /Production tree.*explicit go-ahead/s);
  });

  test("hermes: profile-scoped, never the default profile ($HERMES_HOME/profiles/<name>/SOUL.md)", () => {
    assert.equal(hermesProfileDir(HOME), `/home/test/.hermes/profiles/${HERMES_SOUL_PROFILE}`);
    assert.equal(hermesSoulFile(HOME).path, `/home/test/.hermes/profiles/${HERMES_SOUL_PROFILE}/SOUL.md`);
    assert.equal(hermesSoulFile(HOME).content, SOUL_BODY);
  });
  test("hermes profile create command names the dedicated profile, never 'default'", () => {
    const cmd = hermesProfileCreateCommand();
    assert.equal(cmd.cmd, "hermes");
    assert.deepEqual(cmd.args.slice(0, 3), ["profile", "create", HERMES_SOUL_PROFILE]);
    assert.notEqual(HERMES_SOUL_PROFILE, "default");
  });

  test("openclaw: same workspace as the research log (resolveWorkspaceBootstrapPath is cwd-relative, not global)", () => {
    assert.equal(openclawSoulFile(HOME).path, "/home/test/.family-history/SOUL.md");
    assert.equal(openclawSoulFile(HOME).content, SOUL_BODY);
  });
});

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
