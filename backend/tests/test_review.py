import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
import yaml

from scribe import config


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
    sessions_file = config.APPDATA_ROOT / "example-novel" / "review" / "sessions.yml"
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
        "author": "Sarah",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["author"] == "Sarah"
    assert data["text"] == "This needs work"
    assert data["resolved"] is False
    assert "id" in data
    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    assert comments_file.exists()


def test_add_comment_null_byte_scene_rejected(client, sample_project):
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md\x00.txt",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "Comment",
        "author": "Sarah",
    })
    assert r.status_code == 400


def test_list_comments(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "Comment 1",
        "author": "Sarah",
    })
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "d ", "exact": "e", "suffix": " f"},
        "text": "Comment 2",
        "author": "Tom",
    })
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
        "author": "Sarah",
    })
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


@pytest.mark.skipif(not shutil.which("pandoc"), reason="pandoc not installed")
def test_export_review_epub(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    r = client.get(f"/api/review/{token}/export?format=epub")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/epub+zip"
    assert "attachment" in r.headers["content-disposition"]
    assert len(r.content) > 0


def test_export_review_invalid_format(client, sample_project):
    session = _create_session(client)
    token = session["token"]
    r = client.get(f"/api/review/{token}/export?format=pdf")
    assert r.status_code == 400


def test_add_comment_path_traversal_rejected(client, sample_project):
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "../../evil/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "pwned",
        "author": "Eve",
    })
    assert r.status_code == 400
    escaped = (sample_project / "../../evil/comments.yml").resolve()
    assert not escaped.exists()


def test_add_comment_scene_outside_session_chapters_rejected(client, sample_project):
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/11_Chapter_11/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "should fail",
        "author": "Eve",
    })
    assert r.status_code in (400, 404)
    comments_file = sample_project / "chapters" / "11_Chapter_11" / "comments.yml"
    assert not comments_file.exists()


def test_render_manuscript_returns_sanitised_html(client, sample_project):
    session = _create_session(client)
    r = client.get(f"/api/review/{session['token']}/manuscript")
    assert r.status_code == 200
    data = r.json()
    assert "chapters" in data
    ch = data["chapters"][0]
    assert "scenes" in ch
    for scene in ch["scenes"]:
        assert "<script>" not in scene["html"]
        assert "class=" not in scene["html"] or "review" not in scene["html"]


def test_render_manuscript_strips_script_tags(client, sample_project):
    scene_path = sample_project / "chapters" / "01_Chapter_01" / "01.md"
    scene_path.write_text(
        "---\nscene: 1\norder: 1\n---\n<script>alert('xss')</script>\n\nSafe text.\n",
        encoding="utf-8",
    )
    session = _create_session(client)
    r = client.get(f"/api/review/{session['token']}/manuscript")
    assert r.status_code == 200
    html = r.json()["chapters"][0]["scenes"][0]["html"]
    assert "<script>" not in html
    assert "alert" not in html
    assert "Safe text" in html


def test_concurrent_comments_all_survive(client, sample_project):
    session = _create_session(client)
    token = session["token"]

    def post(i: int) -> int:
        r = client.post(f"/api/review/{token}/comments", json={
            "scene": "chapters/01_Chapter_01/01.md",
            "anchor": {"prefix": "a ", "exact": f"b{i}", "suffix": " c"},
            "text": f"Comment {i}",
            "author": "Sarah",
        })
        return r.status_code

    with ThreadPoolExecutor(max_workers=20) as pool:
        statuses = list(pool.map(post, range(20)))

    assert statuses == [200] * 20
    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    saved = yaml.safe_load(comments_file.read_text(encoding="utf-8"))
    assert len(saved) == 20
    assert len({c["id"] for c in saved}) == 20


def test_reviewer_name_truncated(client, sample_project):
    session = _create_session(client)
    long_name = "A" * 200
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "", "exact": "Tarn", "suffix": ""},
        "text": "test",
        "author": long_name,
    })
    assert r.status_code == 200
    assert len(r.json()["author"]) <= 100


def test_reviewer_name_defaults_to_anonymous(client, sample_project):
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "", "exact": "Tarn", "suffix": ""},
        "text": "test",
    })
    assert r.status_code == 200
    assert r.json()["author"] == "Anonymous"


def test_reviewer_name_header_no_longer_used(client, sample_project):
    """X-Reviewer-Name header is gone; author must come from the JSON body."""
    session = _create_session(client)
    r = client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "", "exact": "Tarn", "suffix": ""},
        "text": "test",
    }, headers={"X-Reviewer-Name": "Sarah"})
    assert r.status_code == 200
    assert r.json()["author"] == "Anonymous"


def test_add_comment_utf8_author_round_trips(client, sample_project):
    session = _create_session(client)
    for name in ("Žofia", "田中太郎"):
        r = client.post(f"/api/review/{session['token']}/comments", json={
            "scene": "chapters/01_Chapter_01/01.md",
            "anchor": {"prefix": "", "exact": "Tarn", "suffix": ""},
            "text": "utf8 name test",
            "author": name,
        })
        assert r.status_code == 200
        assert r.json()["author"] == name


def test_owner_manuscript_works_for_revoked_session(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    token = session["token"]
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})

    owner_r = client.get(f"/api/projects/example-novel/review/sessions/{sid}/manuscript")
    assert owner_r.status_code == 200
    assert "chapters" in owner_r.json()

    public_r = client.get(f"/api/review/{token}/manuscript")
    assert public_r.status_code == 404


def test_owner_comments_works_for_revoked_session(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    token = session["token"]
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "before revoke",
        "author": "Sarah",
    })
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})

    owner_r = client.get(f"/api/projects/example-novel/review/sessions/{sid}/comments")
    assert owner_r.status_code == 200
    assert len(owner_r.json()) == 1

    public_r = client.get(f"/api/review/{token}/comments")
    assert public_r.status_code == 404


def test_owner_manuscript_unknown_session_404(client, sample_project):
    r = client.get("/api/projects/example-novel/review/sessions/nonexistent/manuscript")
    assert r.status_code == 404


def test_owner_resolve_comment_works_for_revoked_session(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    token = session["token"]
    r = client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "resolve me",
        "author": "Sarah",
    })
    cid = r.json()["id"]
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})

    owner_r = client.patch(
        f"/api/projects/example-novel/review/sessions/{sid}/comments/{cid}", json={"resolved": True},
    )
    assert owner_r.status_code == 200
    assert owner_r.json()["resolved"] is True

    public_r = client.patch(f"/api/review/{token}/comments/{cid}", json={"resolved": False})
    assert public_r.status_code == 404


def test_delete_session_cascades_comments_but_spares_other_sessions(client, sample_project):
    s1 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    }).json()
    s2 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 2", "chapters": ["chapters/01_Chapter_01"],
    }).json()

    client.post(f"/api/review/{s1['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "from session 1",
        "author": "Sarah",
    })
    client.post(f"/api/review/{s2['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "d ", "exact": "e", "suffix": " f"},
        "text": "from session 2",
        "author": "Tom",
    })

    r = client.delete(f"/api/projects/example-novel/review/sessions/{s1['id']}")
    assert r.status_code == 204

    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    saved = yaml.safe_load(comments_file.read_text(encoding="utf-8"))
    assert len(saved) == 1
    assert saved[0]["session"] == s2["id"]
    assert saved[0]["text"] == "from session 2"


def test_create_session_sets_default_expiry(client, sample_project):
    session = _create_session(client)
    created = datetime.fromisoformat(session["created"])
    expires = datetime.fromisoformat(session["expires"])
    assert expires - created == timedelta(days=config.REVIEW_SESSION_TTL_DAYS)


def test_create_session_with_explicit_expiry(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Short round", "chapters": ["chapters/01_Chapter_01"],
        "expires": "2099-01-01",
    })
    assert r.status_code == 200
    assert r.json()["expires"].startswith("2099-01-01T23:59:59")


def test_bare_date_expiry_is_inclusive_through_that_day(client, sample_project):
    session = _create_session(client)
    today = datetime.now(UTC).date().isoformat()
    r = client.patch(
        f"/api/projects/example-novel/review/sessions/{session['id']}", json={"expires": today},
    )
    assert r.status_code == 200
    assert client.get(f"/api/review/{session['token']}/manuscript").status_code == 200

    yesterday = (datetime.now(UTC) - timedelta(days=1)).date().isoformat()
    client.patch(
        f"/api/projects/example-novel/review/sessions/{session['id']}", json={"expires": yesterday},
    )
    assert client.get(f"/api/review/{session['token']}/manuscript").status_code == 404


def test_create_session_invalid_expiry_rejected(client, sample_project):
    r = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Bad", "chapters": ["chapters/01_Chapter_01"],
        "expires": "not-a-date",
    })
    assert r.status_code == 400


def test_expired_token_returns_404(client, sample_project):
    session = _create_session(client)
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    r = client.patch(
        f"/api/projects/example-novel/review/sessions/{session['id']}", json={"expires": past},
    )
    assert r.status_code == 200
    assert client.get(f"/api/review/{session['token']}/manuscript").status_code == 404
    assert client.get(f"/api/review/{session['token']}/comments").status_code == 404


def test_extending_expiry_restores_access(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"expires": past})
    assert client.get(f"/api/review/{session['token']}/manuscript").status_code == 404

    future = (datetime.now(UTC) + timedelta(days=30)).isoformat()
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"expires": future})
    assert client.get(f"/api/review/{session['token']}/manuscript").status_code == 200


def test_owner_endpoints_work_for_expired_session(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"expires": past})

    assert client.get(f"/api/projects/example-novel/review/sessions/{sid}/manuscript").status_code == 200
    assert client.get(f"/api/projects/example-novel/review/sessions/{sid}/comments").status_code == 200


def test_legacy_session_without_expires_ages_out_from_created(client, sample_project, writing_root):
    sessions_file = config.APPDATA_ROOT / "example-novel" / "review" / "sessions.yml"
    sessions_file.parent.mkdir(parents=True, exist_ok=True)
    old = (datetime.now(UTC) - timedelta(days=config.REVIEW_SESSION_TTL_DAYS + 1)).isoformat()
    fresh = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    sessions_file.write_text(yaml.dump([
        {"id": "old", "name": "Old", "token": "oldtoken1234", "chapters": ["chapters/01_Chapter_01"],
         "created": old, "active": True},
        {"id": "fresh", "name": "Fresh", "token": "freshtoken1234", "chapters": ["chapters/01_Chapter_01"],
         "created": fresh, "active": True},
    ]), encoding="utf-8")

    assert client.get("/api/review/oldtoken1234/manuscript").status_code == 404
    assert client.get("/api/review/freshtoken1234/manuscript").status_code == 200


def test_comment_update_scoped_to_session(client, sample_project):
    s1 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    }).json()
    s2 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 2", "chapters": ["chapters/01_Chapter_01"],
    }).json()
    cid = client.post(f"/api/review/{s1['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "session 1 comment",
        "author": "Sarah",
    }).json()["id"]

    # another session's token can't touch it, nor can the owner via the wrong session
    r = client.patch(f"/api/review/{s2['token']}/comments/{cid}", json={"resolved": True})
    assert r.status_code == 404
    r = client.patch(
        f"/api/projects/example-novel/review/sessions/{s2['id']}/comments/{cid}", json={"resolved": True},
    )
    assert r.status_code == 404

    # the owning session still can
    r = client.patch(f"/api/review/{s1['token']}/comments/{cid}", json={"resolved": True})
    assert r.status_code == 200
    assert r.json()["resolved"] is True


def test_delete_session_cascades_comments_after_chapters_narrowed(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    token = session["token"]
    client.post(f"/api/review/{token}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "in the chapter about to be dropped",
        "author": "Sarah",
    })
    # Narrow the session to a different chapter before deleting — the ch01 comment
    # is no longer in the session's `chapters` list but must still be cascaded away.
    client.patch(
        f"/api/projects/example-novel/review/sessions/{sid}",
        json={"chapters": ["chapters/11_Chapter_11"]},
    )

    r = client.delete(f"/api/projects/example-novel/review/sessions/{sid}")
    assert r.status_code == 204

    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    assert not comments_file.exists()


def test_delete_session_cascade_spares_other_sessions_comments_in_dropped_chapter(client, sample_project):
    s1 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 1", "chapters": ["chapters/01_Chapter_01"],
    }).json()
    s2 = client.post("/api/projects/example-novel/review/sessions", json={
        "name": "Round 2", "chapters": ["chapters/01_Chapter_01"],
    }).json()
    client.post(f"/api/review/{s1['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "session 1, will be narrowed away then deleted",
        "author": "Sarah",
    })
    client.post(f"/api/review/{s2['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "d ", "exact": "e", "suffix": " f"},
        "text": "session 2, stays",
        "author": "Tom",
    })
    client.patch(
        f"/api/projects/example-novel/review/sessions/{s1['id']}",
        json={"chapters": ["chapters/11_Chapter_11"]},
    )

    r = client.delete(f"/api/projects/example-novel/review/sessions/{s1['id']}")
    assert r.status_code == 204

    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    saved = yaml.safe_load(comments_file.read_text(encoding="utf-8"))
    assert len(saved) == 1
    assert saved[0]["session"] == s2["id"]


def test_owner_export_works_for_active_revoked_and_expired_sessions(client, sample_project):
    session = _create_session(client)
    sid = session["id"]

    r_active = client.get(f"/api/projects/example-novel/review/sessions/{sid}/export?format=md")
    assert r_active.status_code == 200
    assert "text/markdown" in r_active.headers["content-type"]

    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})
    r_revoked = client.get(f"/api/projects/example-novel/review/sessions/{sid}/export?format=md")
    assert r_revoked.status_code == 200

    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"expires": past})
    r_expired = client.get(f"/api/projects/example-novel/review/sessions/{sid}/export?format=md")
    assert r_expired.status_code == 200

    # Public export still 404s once the session is revoked/expired.
    public_r = client.get(f"/api/review/{session['token']}/export?format=md")
    assert public_r.status_code == 404


def test_owner_export_invalid_format_rejected(client, sample_project):
    session = _create_session(client)
    r = client.get(f"/api/projects/example-novel/review/sessions/{session['id']}/export?format=pdf")
    assert r.status_code == 400


def test_owner_comment_post_works_on_revoked_session(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    client.patch(f"/api/projects/example-novel/review/sessions/{sid}", json={"active": False})

    r = client.post(f"/api/projects/example-novel/review/sessions/{sid}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "owner posting on a revoked session",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["author"] == "Author"
    assert data["session"] == sid

    owner_comments = client.get(f"/api/projects/example-novel/review/sessions/{sid}/comments")
    assert len(owner_comments.json()) == 1


def test_owner_comment_post_rejects_scene_outside_session_chapters(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    r = client.post(f"/api/projects/example-novel/review/sessions/{sid}/comments", json={
        "scene": "chapters/11_Chapter_11/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "should fail",
    })
    assert r.status_code in (400, 404)
    comments_file = sample_project / "chapters" / "11_Chapter_11" / "comments.yml"
    assert not comments_file.exists()


def test_owner_comment_post_honors_explicit_author(client, sample_project):
    session = _create_session(client)
    sid = session["id"]
    r = client.post(f"/api/projects/example-novel/review/sessions/{sid}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "signed comment",
        "author": "Russell",
    })
    assert r.status_code == 200
    assert r.json()["author"] == "Russell"


def test_delete_session_removes_comments_file_when_empty(client, sample_project):
    session = _create_session(client)
    client.post(f"/api/review/{session['token']}/comments", json={
        "scene": "chapters/01_Chapter_01/01.md",
        "anchor": {"prefix": "a ", "exact": "b", "suffix": " c"},
        "text": "only comment",
        "author": "Sarah",
    })
    comments_file = sample_project / "chapters" / "01_Chapter_01" / "comments.yml"
    assert comments_file.exists()

    r = client.delete(f"/api/projects/example-novel/review/sessions/{session['id']}")
    assert r.status_code == 204
    assert not comments_file.exists()
