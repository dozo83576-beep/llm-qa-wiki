from __future__ import annotations

import datetime as dt
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "qa_toolkit.py"
SPEC = importlib.util.spec_from_file_location("qa_toolkit", MODULE_PATH)
qa = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(qa)
FIXTURES = pathlib.Path(__file__).parent / "fixtures"


class ToolkitTests(unittest.TestCase):
    def project(self):
        return tempfile.TemporaryDirectory()

    def auth(self, origin="https://example.invalid", *, expired=False, operation="zap-baseline"):
        now = dt.datetime.now(dt.timezone.utc)
        if expired:
            start, end = now - dt.timedelta(hours=2), now - dt.timedelta(hours=1)
        else:
            start, end = now - dt.timedelta(minutes=1), now + dt.timedelta(minutes=10)
        return {
            "allowed_origins": [origin],
            "allowed_operations": [operation],
            "not_before": qa.iso(start),
            "expires": qa.iso(end),
        }

    def test_catalog_has_exact_version_contract(self):
        catalog = json.loads((MODULE_PATH.parents[2] / "resources" / "qa-tool-catalog.yaml").read_text(encoding="utf-8"))
        self.assertEqual(11, len(catalog["tools"]))
        required = {"id", "capability", "official_upstream", "license", "version", "tested_version", "version_policy", "os_runtime", "risk_class", "inputs", "outputs", "limitations", "pipeline_phase", "checked_at"}
        for profile in catalog["tools"]:
            self.assertTrue(required <= profile.keys())
            self.assertRegex(profile["version"], r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
            self.assertEqual(profile["version"], profile["tested_version"])

    def test_catalog_runner_id_parity(self):
        self.assertEqual(set(qa.TOOLS), set(qa.load_catalog()))

    def test_pact_verifier_cli_discovery_matches_catalog_pin(self):
        profile = qa.load_catalog()["pact"]
        self.assertEqual("pact_verifier_cli", profile["implementation"])
        self.assertEqual("1.3.3", profile["version"])
        with self.project() as folder, mock.patch.object(qa, "find_executable", return_value="pact_verifier_cli"), mock.patch.object(qa, "discover_version", return_value="1.3.3"):
            pathlib.Path(folder, "pact.json").write_text("{}", encoding="utf-8")
            result, _ = qa.run("pact", '{"pact_files":["pact.json"],"provider_url":"http://127.0.0.1:8080"}', folder, True, False, None)
        self.assertEqual("clean", result["status"])
        self.assertEqual("1.3.3", result["version"])

    def test_testcontainers_library_pin_and_docker_version_are_separate(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            (root / "gradle.lockfile").write_text("org.testcontainers:testcontainers:2.0.5=runtimeClasspath\n", encoding="utf-8")
            config = json.dumps({"dependency_lock": "gradle.lockfile", "image_digest": "sha256:" + "a" * 64})
            with mock.patch.object(qa, "find_executable", return_value="docker"), mock.patch.object(qa, "discover_version", return_value="27.4.1"):
                result, _ = qa.run("testcontainers", config, folder, True, False, None)
        self.assertEqual("clean", result["status"])
        self.assertEqual("2.0.5", result["version"])
        self.assertEqual({"docker": "27.4.1"}, result["prerequisite_versions"])

    def test_testcontainers_missing_docker_is_blocked(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            (root / "pom.xml").write_text("<dependency>org.testcontainers:testcontainers:2.0.5</dependency>", encoding="utf-8")
            with mock.patch.object(qa, "find_executable", return_value=None):
                result, _ = qa.run("testcontainers", '{"dependency_lock":"pom.xml","image_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', folder, True, False, None)
        self.assertEqual("blocked", result["status"])
        self.assertIn("missing", result["reason"])

    def test_result_schema_and_signal_contract(self):
        with self.project() as folder, mock.patch.object(qa, "find_executable", return_value=sys.executable), mock.patch.object(qa, "discover_version", return_value="4.12.1"):
            result, result_path = qa.run("axe-core", '{"target":"https://example.invalid"}', folder, True, False, None)
            self.assertEqual("clean", result["status"])
            self.assertTrue(qa.validate_result_schema(result))
            self.assertTrue(result["signals_only"])
            self.assertTrue(result_path.is_file())
            self.assertIn("evidence/data/tool-runs", result_path.as_posix())

    def test_junit_normalization_and_redaction(self):
        normalized = qa.normalize_junit(FIXTURES / "junit.xml")
        self.assertEqual({"tests": 3, "findings": 1, "skipped": 1}, normalized["summary"])
        text = json.dumps(normalized)
        self.assertNotIn("qa.person", text)
        self.assertNotIn("fixture-secret", text)

    def test_sarif_normalization_and_redaction(self):
        normalized = qa.normalize_sarif(FIXTURES / "findings.sarif")
        self.assertEqual(1, normalized["summary"]["findings"])
        text = json.dumps(normalized)
        self.assertNotIn("qa.person", text)
        self.assertNotIn("fixture-secret", text)

    def test_profile_json_normalization_and_redaction(self):
        normalized = qa.normalize_profile_json(FIXTURES / "profile.json")
        self.assertEqual(1, normalized["summary"]["findings"])
        text = json.dumps(normalized)
        self.assertNotIn("fixture-secret", text)
        self.assertNotIn("fixture-cookie", text)

    def test_path_traversal_is_blocked(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            outside = root.parent / "outside.json"
            with self.assertRaises(qa.Blocked):
                qa.project_path(root, str(outside))

    def test_local_executable_requires_manifest(self):
        with self.project() as folder:
            local_root = pathlib.Path(folder) / ".qa-tools"
            executable = local_root / "axe-core" / "bin" / "axe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"fixture")
            with self.assertRaises(qa.Blocked):
                qa.find_executable("axe-core", local_root, "4.12.1")

    def test_local_executable_tamper_is_blocked(self):
        with self.project() as folder:
            local_root = pathlib.Path(folder) / ".qa-tools"
            tool_root = local_root / "axe-core"
            executable = tool_root / "bin" / "axe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"trusted")
            (tool_root / "install-manifest.json").write_text(json.dumps({"path": "bin/axe", "version": "4.12.1", "sha256": qa.sha256(executable)}), encoding="utf-8")
            executable.write_bytes(b"tampered")
            with self.assertRaises(qa.Blocked):
                qa.find_executable("axe-core", local_root, "4.12.1")

    def test_local_executable_symlink_is_blocked(self):
        with self.project() as folder:
            local_root = pathlib.Path(folder) / ".qa-tools"
            tool_root = local_root / "axe-core"
            executable = tool_root / "bin" / "axe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"fixture")
            (tool_root / "install-manifest.json").write_text(json.dumps({"path": "bin/axe", "version": "4.12.1", "sha256": qa.sha256(executable)}), encoding="utf-8")
            with mock.patch.object(qa, "_is_link_or_reparse", return_value=True), self.assertRaises(qa.Blocked):
                qa.find_executable("axe-core", local_root, "4.12.1")

    def test_missing_prerequisite_is_blocked_not_crash(self):
        with self.project() as folder, mock.patch.object(qa, "find_executable", return_value=None):
            result, _ = qa.run("axe-core", '{"target":"https://example.invalid"}', folder, True, False, None)
            self.assertEqual("blocked", result["status"])
            self.assertIn("missing", result["reason"])

    def test_unknown_discovered_version_is_blocked(self):
        with self.project() as folder, mock.patch.object(qa, "find_executable", return_value=sys.executable), mock.patch.object(qa, "discover_version", return_value=None):
            result, _ = qa.run("axe-core", '{"target":"https://example.invalid"}', folder, True, False, None)
            self.assertEqual("blocked", result["status"])
            self.assertIn("unable to discover", result["reason"])

    def test_mismatched_discovered_version_is_blocked(self):
        with self.project() as folder, mock.patch.object(qa, "find_executable", return_value=sys.executable), mock.patch.object(qa, "discover_version", return_value="9.9.9"):
            result, _ = qa.run("axe-core", '{"target":"https://example.invalid"}', folder, True, False, None)
            self.assertEqual("blocked", result["status"])
            self.assertIn("version mismatch", result["reason"])

    def test_zap_without_authorization_blocks_before_process(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            result, _ = qa.run("zap-baseline", '{"target":"https://example.invalid"}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_zap_foreign_origin_blocks_before_process(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            root = pathlib.Path(folder)
            auth_path = root / "auth.json"
            auth_path.write_text(json.dumps(self.auth("https://other.invalid")), encoding="utf-8")
            result, _ = qa.run("zap-baseline", '{"target":"https://example.invalid"}', folder, False, False, str(auth_path))
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_zap_expired_window_blocks_before_process(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            root = pathlib.Path(folder)
            auth_path = root / "auth.json"
            auth_path.write_text(json.dumps(self.auth(expired=True)), encoding="utf-8")
            result, _ = qa.run("zap-baseline", '{"target":"https://example.invalid"}', folder, False, False, str(auth_path))
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_zap_active_mode_is_rejected(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            result, _ = qa.run("zap-baseline", '{"target":"https://example.invalid","active_scan":true}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_schemathesis_unsafe_methods_require_test_env_or_auth(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            result, _ = qa.run("schemathesis", '{"schema":"schema.json","base_url":"https://example.invalid","methods":["POST"]}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_schemathesis_test_environment_cannot_bypass_authorization(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            result, _ = qa.run("schemathesis", '{"schema":"schema.json","base_url":"https://example.invalid","methods":["POST"],"test_environment":true}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_oasdiff_remote_ref_is_blocked(self):
        with self.project() as folder, mock.patch.object(qa.subprocess, "run") as process:
            root = pathlib.Path(folder)
            (root / "base.json").write_text('{"openapi":"3.0.0","paths":{}}', encoding="utf-8")
            (root / "next.json").write_text('{"components":{"schemas":{"A":{"$ref":"https://example.invalid/schema.json"}}}}', encoding="utf-8")
            result, _ = qa.run("oasdiff", '{"base":"base.json","revision":"next.json"}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_ios_on_windows_is_blocked(self):
        with self.project() as folder, mock.patch.object(qa.platform, "system", return_value="Windows"), mock.patch.object(qa.subprocess, "run") as process:
            result, _ = qa.run("maestro", '{"platform":"ios","flow":"flow.yaml"}', folder, False, False, None)
            self.assertEqual("blocked", result["status"])
            process.assert_not_called()

    def test_hardcoded_command_keeps_target_as_single_argument(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            run_dir = root / "run"
            run_dir.mkdir()
            command, _ = qa.build_command("axe-core", "axe", root, run_dir, {"target": "https://example.invalid/;calc.exe", "tags": ["wcag2a"]})
            self.assertIsInstance(command, list)
            self.assertEqual("https://example.invalid/;calc.exe", command[1])
            self.assertNotIn("shell", command)

    def test_bounded_profile_command_shapes(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            run_dir = root / "run"
            run_dir.mkdir()
            (root / "pact.json").write_text("{}", encoding="utf-8")
            (root / "caps.json").write_text('{"alwaysMatch":{"platformName":"Android"}}', encoding="utf-8")
            mappings = root / "wiremock"
            mappings.mkdir()
            pact, _ = qa.build_command("pact", "pact_verifier_cli", root, run_dir, {"provider_url": "https://127.0.0.1:8443/api/v1/", "pact_files": ["pact.json"]})
            self.assertIn("--junit", pact)
            self.assertIn("--file", pact)
            self.assertNotIn("--publish", pact)
            self.assertNotIn("--provider-url", pact)
            self.assertEqual("127.0.0.1", pact[pact.index("--hostname") + 1])
            self.assertEqual("8443", pact[pact.index("--port") + 1])
            self.assertEqual("https", pact[pact.index("--transport") + 1])
            self.assertEqual("/api/v1", pact[pact.index("--base-path") + 1])
            appium, _ = qa.build_command("appium", "appium", root, run_dir, {"capabilities": "caps.json", "port": 4723})
            self.assertEqual("127.0.0.1", appium[appium.index("--address") + 1])
            wiremock, _ = qa.build_command("wiremock", "wiremock", root, run_dir, {"mappings_dir": "wiremock", "port": 18089})
            self.assertEqual("127.0.0.1", wiremock[wiremock.index("--bind-address") + 1])
            container, _ = qa.build_command("testcontainers", "docker", root, run_dir, {"image_digest": "sha256:" + "a" * 64})
            self.assertIn("--pull=never", container)
            self.assertIn("alpine:3.22@sha256:" + "a" * 64, container)

    def test_zap_docker_baseline_cli_contract(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            run_dir = root / "run"
            run_dir.mkdir()
            command, artifact = qa.build_command("zap-baseline", "docker", root, run_dir, {"target": "https://example.invalid", "image_digest": "sha256:" + "b" * 64})
            self.assertEqual(["docker", "run", "--rm", "--pull=never"], command[:4])
            self.assertRegex(command[command.index("--name") + 1], r"^qa-zap-[a-z0-9]{12}$")
            self.assertIn("zaproxy/zap-stable:2.17.0@sha256:" + "b" * 64, command)
            self.assertIn("zap-baseline.py", command)
            self.assertNotIn("-a", command)
            self.assertEqual((run_dir / "zap.json").resolve(), artifact.resolve())

    def test_zap_discovers_docker_with_double_dash_version(self):
        completed = subprocess.CompletedProcess(["docker", "--version"], 0, "Docker version 27.4.1", "")
        with mock.patch.object(qa.subprocess, "run", return_value=completed) as process:
            self.assertEqual("27.4.1", qa.discover_version("docker", "zap-baseline"))
        self.assertEqual(["docker", "--version"], process.call_args.args[0])

    def test_zap_container_cleanup_runs_after_timeout(self):
        command = ["docker", "run", "--rm", "--pull=never", "--name", "qa-zap-123456789abc", "image"]
        failure = subprocess.TimeoutExpired(command, 1)
        cleanup = subprocess.CompletedProcess(["docker", "rm", "-f", "qa-zap-123456789abc"], 0, "", "")
        with self.project() as folder, mock.patch.object(qa.subprocess, "run", side_effect=[failure, cleanup]) as process:
            with self.assertRaises(subprocess.TimeoutExpired):
                qa.execute_container_smoke(command, "docker", pathlib.Path(folder), 1)
        self.assertEqual(["docker", "rm", "-f", "qa-zap-123456789abc"], process.call_args_list[1].args[0])

    def test_container_cleanup_runs_after_execution_failure(self):
        command = ["docker", "run", "--rm", "--name", "qa-toolkit-fixture", "alpine@sha256:" + "a" * 64]
        failure = subprocess.TimeoutExpired(command, 1)
        cleanup = subprocess.CompletedProcess(["docker", "rm", "-f", "qa-toolkit-fixture"], 0, "", "")
        with self.project() as folder, mock.patch.object(qa.subprocess, "run", side_effect=[failure, cleanup]) as process:
            with self.assertRaises(subprocess.TimeoutExpired):
                qa.execute_container_smoke(command, "docker", pathlib.Path(folder), 1)
        self.assertEqual(2, process.call_count)
        self.assertEqual(["docker", "rm", "-f", "qa-toolkit-fixture"], process.call_args_list[1].args[0])

    def test_cli_exit_contract(self):
        fake_path = pathlib.Path("result.json")
        for status, expected in (("clean", 0), ("findings", 0), ("blocked", 3), ("error", 1)):
            with self.subTest(status=status), mock.patch.object(qa, "run", return_value=({"status": status}, fake_path)):
                self.assertEqual(expected, qa.main(["--tool", "axe-core", "--config", "{}", "--project-root", "."]))

    def test_gitleaks_command_is_directory_only_without_git_history(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            run_dir = root / "run"
            run_dir.mkdir()
            command, _ = qa.build_command("gitleaks", "gitleaks", root, run_dir, {"delivery_dir": "delivery"})
            self.assertIn("--no-git", command)
            self.assertNotIn("--log-opts", command)
            self.assertEqual(str(delivery.resolve()), command[command.index("--source") + 1])

    def test_upstream_shape_normalizers(self):
        axe = qa.normalize_axe(FIXTURES / "axe.json")
        self.assertEqual(2, axe["summary"]["findings"])
        self.assertEqual(1, axe["summary"]["manual_review_required"])
        self.assertTrue(any(item["manual_review_required"] for item in axe["findings"]))
        self.assertEqual(1, qa.normalize_zap(FIXTURES / "zap.json")["summary"]["findings"])
        self.assertEqual(1, qa.normalize_oasdiff(FIXTURES / "oasdiff.json")["summary"]["findings"])
        lighthouse = qa.normalize_lighthouse(FIXTURES / "lighthouse.json")
        self.assertEqual(3, lighthouse["summary"]["findings"])
        self.assertTrue(lighthouse["summary"]["lab_data"])
        self.assertNotIn("fixture-secret", json.dumps(lighthouse))

    def test_lighthouse_collects_local_artifacts_and_hashes(self):
        with self.project() as folder:
            root = pathlib.Path(folder)
            (root / "budget.json").write_text("[]", encoding="utf-8")

            def fake_process(command, **kwargs):
                if command[1] == "collect":
                    out_dir = pathlib.Path(command[command.index("--outputDir") + 1])
                    shutil.copyfile(FIXTURES / "lighthouse.json", out_dir / "lhr-1.json")
                return subprocess.CompletedProcess(command, 0, "", "")

            config = json.dumps({"target": "https://example.invalid", "runs": 3, "budget_file": "budget.json"})
            with mock.patch.object(qa, "find_executable", return_value="lhci"), mock.patch.object(qa, "discover_version", return_value="0.15.1"), mock.patch.object(qa.subprocess, "run", side_effect=fake_process):
                result, _ = qa.run("lighthouse-ci", config, folder, False, False, None)
            self.assertEqual("findings", result["status"])
            self.assertEqual(1, len(result["artifacts"]))
            artifact = result["artifacts"][0]
            self.assertEqual(artifact["sha256"], result["hashes"][artifact["path"]])
            self.assertEqual(64, len(artifact["sha256"]))

    def test_controlled_artifact_path_is_not_phone_or_email_redacted(self):
        relative = "evidence/data/tool-runs/20260804-123456/user@example.test.json"
        digest = "a" * 64
        result = {
            "artifacts": [{"path": relative, "sha256": digest, "normalized": {"message": "user@example.test"}}],
            "hashes": {relative: digest},
        }
        safe = qa.redact_result(result)
        self.assertEqual(relative, safe["artifacts"][0]["path"])
        self.assertEqual({relative: digest}, safe["hashes"])
        self.assertEqual("[REDACTED_EMAIL]", safe["artifacts"][0]["normalized"]["message"])
        with self.assertRaises(ValueError):
            qa.controlled_artifact_path("../outside.json")


if __name__ == "__main__":
    unittest.main()
