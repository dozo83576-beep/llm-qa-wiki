import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_agent_skills.py")
SPEC = importlib.util.spec_from_file_location("validate_agent_skills", MODULE_PATH)
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class AgentSkillValidatorTests(unittest.TestCase):
    def make_skill(self, root: Path, name: str, skill: str, prompt: str | None = None) -> Path:
        directory = root / "agent-skills" / name
        (directory / "agents").mkdir(parents=True)
        (directory / "SKILL.md").write_text(skill, encoding="utf-8")
        prompt = prompt or f"Use ${name} to produce the requested artifact."
        (directory / "agents" / "openai.yaml").write_text(
            'interface:\n'
            '  display_name: "Fixture Skill"\n'
            '  short_description: "Детерминированная проверка тестового скилла"\n'
            f'  default_prompt: "{prompt}"\n\n'
            'policy:\n'
            '  allow_implicit_invocation: false\n',
            encoding="utf-8",
        )
        return directory

    def test_positive_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill = self.make_skill(root, "sample-skill", "---\nname: sample-skill\ndescription: Проверяет локальный fixture.\n---\n\n# Sample\n\nСоздать artifact.\n")
            self.assertEqual(VALIDATOR.validate_skill(skill, root), [])

    def test_negative_frontmatter_reference_and_runtime_dependency(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill = self.make_skill(
                root,
                "bad-skill",
                "---\nname: wrong\ndescription: Проверяет fixture.\nmetadata: bad\n---\n\n# Bad\n\nMCP обязателен. `docs\\missing.md` TODO\n",
                "Use $wrong now.",
            )
            errors = VALIDATOR.validate_skill(skill, root)
            self.assertTrue(any("только name и description" in item for item in errors))

    def test_negative_openai_yaml(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill = self.make_skill(root, "bad-ui", "---\nname: bad-ui\ndescription: Проверяет UI metadata.\n---\n\n# Bad UI\n")
            (skill / "agents" / "openai.yaml").write_text("interface:\n  display_name: unquoted\n", encoding="utf-8")
            errors = VALIDATOR.validate_skill(skill, root)
            self.assertTrue(any("quoted string" in item for item in errors))

    def test_interface_fields_nested_under_policy_do_not_satisfy_interface(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill = self.make_skill(root, "bad-nesting", "---\nname: bad-nesting\ndescription: Проверяет вложенность metadata.\n---\n\n# Bad nesting\n")
            (skill / "agents" / "openai.yaml").write_text(
                'interface:\n  allow_implicit_invocation: false\npolicy:\n'
                '  display_name: "Wrong place"\n'
                '  short_description: "Поля находятся в неправильной секции"\n'
                '  default_prompt: "Use $bad-nesting incorrectly."\n', encoding="utf-8")
            errors = VALIDATOR.validate_skill(skill, root)
            self.assertTrue(any("interface.display_name" in item for item in errors))
            self.assertTrue(any("interface содержит неподдерживаемые" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
