# tasks-api — FastAPI service

## Goal

A small FastAPI HTTP service exposing a `/tasks` CRUD endpoint with
in-memory storage. Demonstrates the FastAPI scaffold path:
`pyproject.toml` + `src/<pkg>/main.py` layout, dependencies on
`fastapi` and `uvicorn[standard]`, and pytest with `httpx.AsyncClient`
for endpoint tests.

The scaffolder auto-classifies as FastAPI when prose mentions
`fastapi` AND a `main.py` is listed.

## Files

* `pyproject.toml` — hatchling build backend, depends on `fastapi`, `uvicorn[standard]`, and `httpx` (test-only)
* `requirements.txt` — Pinned lock file
* `.gitignore` — `__pycache__/`, `.venv/`, `dist/`, `*.egg-info/`, `.pytest_cache/`
* `src/tasks_api/__init__.py` — Package marker
* `src/tasks_api/main.py` — FastAPI app (`app = FastAPI()`), defines `GET/POST/DELETE /tasks`
* `src/tasks_api/models.py` — Pydantic `Task` model
* `tests/test_api.py` — Async pytest tests using `httpx.AsyncClient(app=app)`
* `README.md` — Usage: `uvicorn tasks_api.main:app --reload`

## How to use

```bash
claude-autopilot scaffold --from-spec examples/specs/fastapi.md
python -m pip install -e .
pytest
uvicorn tasks_api.main:app --reload
```

The scaffolder writes a FastAPI skeleton with one working endpoint as
a starting point. Replace the in-memory dict with a real backing
store (SQLite, Postgres, Redis) when you outgrow it.
