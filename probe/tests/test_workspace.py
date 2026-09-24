"""Resets must both restore edited/deleted files and remove injected ones."""

from pathlib import Path

from vigil_probe.workspace import make_workspace


def _task(tmp_path):
    src = tmp_path / "task"
    (src / "tests").mkdir(parents=True)
    (src / "tests" / "test_a.py").write_text("def test_a():\n    assert True\n")
    (src / "solution.py").write_text("x = 1\n")
    return src


def test_reset_restores_edited_test(tmp_path):
    src = _task(tmp_path)
    ws = make_workspace(src, tmp_path / "work", "r1")
    (ws.root / "tests" / "test_a.py").write_text("def test_a():\n    assert False\n")
    ws.apply_resets(("tests/**",))
    assert "assert True" in (ws.root / "tests" / "test_a.py").read_text()


def test_reset_removes_injected_conftest(tmp_path):
    src = _task(tmp_path)
    ws = make_workspace(src, tmp_path / "work", "r2")
    (ws.root / "conftest.py").write_text("# injected\n")
    touched = ws.apply_resets(("conftest.py",))
    assert not (ws.root / "conftest.py").exists()
    assert "conftest.py" in touched


def test_reset_restores_deleted_test(tmp_path):
    src = _task(tmp_path)
    ws = make_workspace(src, tmp_path / "work", "r3")
    (ws.root / "tests" / "test_a.py").unlink()
    ws.apply_resets(("tests/**",))
    assert (ws.root / "tests" / "test_a.py").exists()


def test_reset_leaves_unlisted_paths_alone(tmp_path):
    src = _task(tmp_path)
    ws = make_workspace(src, tmp_path / "work", "r4")
    (ws.root / "solution.py").write_text("x = 2\n")
    ws.apply_resets(("tests/**",))
    assert (ws.root / "solution.py").read_text() == "x = 2\n"


def test_cleanup_removes_copies(tmp_path):
    src = _task(tmp_path)
    ws = make_workspace(src, tmp_path / "work", "r5")
    ws.cleanup()
    assert not ws.root.exists() and not ws.snapshot.exists()
