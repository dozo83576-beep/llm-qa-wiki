from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


TOOLS = pathlib.Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


verifier = load_module("verify_qa_report_evidence", "verify-qa-report.py")
packer = load_module("pack_delivery_evidence", "pack-delivery.py")


def png_header(width: int = 1913, height: int = 907, tail: bytes = b"") -> bytes:
    data = bytearray(33)
    data[:8] = b"\x89PNG\r\n\x1a\n"
    data[8:12] = (13).to_bytes(4, "big")
    data[12:16] = b"IHDR"
    data[16:20] = width.to_bytes(4, "big")
    data[20:24] = height.to_bytes(4, "big")
    data[24] = 8
    data[25] = 2
    return bytes(data) + tail


def approved_manifest(payload: bytes) -> dict:
    return {
        "schemaVersion": 1,
        "runner": "functional-screenshots",
        "status": "approved",
        "approval": {"status": "approved", "runId": "test-run"},
        "requestedCaseIds": ["TC-001"],
        "cases": [{
            "id": "TC-001",
            "status": "captured",
            "file": "TC-001.png",
            "viewport": {"width": 1913, "height": 907},
            "sha256": hashlib.sha256(payload).hexdigest(),
        }],
    }


class EvidenceManifestTests(unittest.TestCase):
    def project(self) -> tuple[pathlib.Path, bytes]:
        root = pathlib.Path(tempfile.mkdtemp(prefix="evidence-delivery-"))
        evidence = root / "evidence"
        outputs = root / "outputs"
        evidence.mkdir()
        outputs.mkdir()
        payload = png_header(tail=b"evidence")
        (evidence / "TC-001.png").write_bytes(payload)
        (outputs / "QA_Test.xlsx").write_bytes(b"xlsx")
        (outputs / "ОТЧЁТ.md").write_text("Отчёт", encoding="utf-8")
        return root, payload

    def test_legacy_evidence_without_manifest_remains_valid(self):
        root, _ = self.project()
        failures: list[str] = []
        verifier.check_evidence_manifest(root / "evidence", failures)
        self.assertEqual(failures, [])
        self.assertTrue(packer.pack(root).is_file())

    def test_unapproved_functional_manifest_blocks_report_and_zip(self):
        root, payload = self.project()
        data = root / "evidence" / "data"
        data.mkdir()
        manifest = approved_manifest(payload)
        manifest["status"] = "clean"
        manifest.pop("approval")
        (data / "screenshot-run.json").write_text(json.dumps(manifest), encoding="utf-8")
        failures: list[str] = []
        verifier.check_evidence_manifest(root / "evidence", failures)
        self.assertTrue(any("не одобрен" in failure.lower() for failure in failures))
        with self.assertRaises(packer.PackError):
            packer.pack(root)

    def test_approved_manifest_revalidates_file_hash_and_dimensions(self):
        root, payload = self.project()
        data = root / "evidence" / "data"
        data.mkdir()
        manifest = approved_manifest(payload)
        manifest_path = data / "screenshot-run.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        failures: list[str] = []
        verifier.check_evidence_manifest(root / "evidence", failures)
        self.assertEqual(failures, [])
        self.assertTrue(packer.pack(root).is_file())

        (root / "evidence" / "TC-001.png").write_bytes(png_header(tail=b"tampered"))
        failures = []
        verifier.check_evidence_manifest(root / "evidence", failures)
        self.assertTrue(any("sha-256" in failure.lower() for failure in failures))


if __name__ == "__main__":
    unittest.main()
