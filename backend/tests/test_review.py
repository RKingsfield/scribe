import pytest
from starlette.testclient import TestClient
from scribe.main import app


@pytest.fixture
def client(sample_project):
    return TestClient(app)


def test_create_session(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Beta Round 1",
        "chapters": ["chapters/01_Chapter_01"],
    })
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "Beta Round 1"
    assert len(data["token"]) == 24
    assert data["active"] is True
    assert data["chapters"] == ["chapters/01_Chapter_01"]
    assert "id" in data
    sessions_file = sample_project / "review" / "sessions.yml"
    assert sessions_file.exists()


def test_list_sessions(client, sample_project):
    client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 2", "chapters": ["chapters/11_Chapter_11"],
    })
    r = client.get("/api/projects/example-novel/review/sessions")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_revoke_session(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    sid = r.json()["id"]
    r2 = client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})
    assert r2.status_code == 200
    assert r2.json()["active"] is False


def test_delete_session(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    sid = r.json()["id"]
    r2 = client.delete(f"/api/projects/example-novel/review/sessions/{sid}")
    assert r2.status_code == 204
    r3 = client.get("/api/projects/example-novel/review/sessions")
    assert len(r3.json()) == 0


def test_get_manuscript_via_token(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    token = r.json()["token"]
    r2 = client.get(f"/api/review/{token}/manuscript")
    assert r2.status_code == 200
    data = r2.json()
    assert "title" in data
    assert "chapters" in data
    assert len(data["chapters"]) >= 1
    ch = data["chapters"][0]
    assert "scenes" in ch
    assert len(ch["scenes"]) >= 1
    assert "<p>" in ch["scenes"][0]["html"] or ch["scenes"][0]["html"].strip() != ""


def test_revoked_token_returns_404(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    token = r.json()["token"]
    sid = r.json()["id"]
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})
    r2 = client.get(f"/api/review/{token}/manuscript")
    assert r2.status_code == 404


def test_invalid_token_returns_404(client):
    r = client.get("/api/review/nonexistent123/manuscript")
    assert r.status_code == 404


def _create_session(client) -> dict:
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    })
    return r.json()


def test_add_comment(client, sample_project):
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "some text before ", "exact": "the highlighted bit", "suffix": " and after"},
        "text": "This needs work",
    }, headers={"X-Reviewer-Name": "Sarah"})
    assert r.status_code == 200
    data = r.json()
    assert data["author"] == "Sarah"
    assert data["text"] == "This needs work"
    assert data["resolved"] is False
    assert "id" in data
    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    assert comments_file.exists()


def test_list_comments(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "Comment 1",
    }, headers={"X-Reviewer-Name": "Sarah"})
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "d ", "exact": "e", "suffix": " f"},
        "text": "Comment 2",
    }, headers={"X-Reviewer-Name": "Tom"})
    r = client.get(f"/api/review/{token}/comments")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_resolve_comment(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    r = client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "Fix this",
    }, headers={"X-Reviewer-Name": "Sarah"})
    cid = r.json()["id"]
    r2 = client.patch(f"/api/review/{token}/comments/{cid}", json={"resolved": True})
    assert r2.status_code == 200
    assert r2.json()["resolved"] is True


def test_export_review_md(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    r = client.get(f"/api/review/{token}/export?format=md")
    assert r.status_code == 200
    assert "text/markdown" in r.headers["content-type"]
    assert "attachment" in r.headers["content-disposition"]
    body = r.text
    assert len(body) > 0


def test_export_review_invalid_format(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    r = client.get(f"/api/review/{token}/export?format=pdf")
    assert r.status_code == 400
