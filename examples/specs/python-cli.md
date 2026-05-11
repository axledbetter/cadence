# wordcount — Python 3.11+ CLI

## Goal

A bare Python CLI that counts words in a text file. Demonstrates the
modern `pyproject.toml` + `src/<pkg>/` layout (the import-isolation
pattern that pytest + hatchling both recommend), with a console
script entry point and pytest-driven tests.

No FastAPI, no web framework — this is the path for "Python script /
library / CLI" specs. For HTTP services see `fastapi.md`.

## Files

* `pyproject.toml` — `[project]` table with hatchling build backend, `requires-python = ">=3.11"`, `dependencies = []`, `[project.scripts] wordcount = "wordcount.cli:main"`
* `requirements.txt` — Lock file; pinned via `pip-compile` or `uv pip compile`
* `.gitignore` — `__pycache__/`, `.venv/`, `dist/`, `*.egg-info/`, `.pytest_cache/`
* `src/wordcount/__init__.py` — Package marker
* `src/wordcount/cli.py` — `main()` entry; parses `argv`, calls counter, prints result
* `src/wordcount/counter.py` — Pure function `count_words(text: str) -> int`
* `tests/test_counter.py` — Unit tests for the counter
* `tests/test_cli.py` — CLI smoke test via `subprocess.run`
* `README.md` — Usage example: `wordcount path/to/file.txt`

## How to use

```bash
claude-autopilot scaffold --from-spec examples/specs/python-cli.md
python -m pip install -e .
pytest
```

The scaffolder writes the package skeleton + a pinned `requirements.txt`
stub. Add your runtime deps to `pyproject.toml` then re-lock.
