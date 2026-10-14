import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, Paper, _author_rows
from app.services import metadata_sync as ms
from app.services.author_names import AuthorName


def paper(db, **kw):
    kw.setdefault("title", "A sufficiently long and ordinary paper title")
    p = Paper(**kw)
    db.add(p)
    db.commit()
    return p


ABSTRACT = "<jats:p>" + "word " * 30 + "</jats:p>"


def msg(**over):
    base = {
        "author": [
            {"given": "John Michael", "family": "Smith", "sequence": "first"},
            {"given": "Jane", "family": "Doe", "suffix": "Jr."},
        ],
        "issued": {"date-parts": [[2019, 5]]},
        "abstract": ABSTRACT,
        "title": ["The Crossref Title"],
        "is-referenced-by-count": 42,
    }
    base.update(over)
    return base


class PureRulesTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()

    def test_crossref_authors_split_given_into_first_and_middle(self):
        names = ms.crossref_authors(msg())
        self.assertEqual(
            [(n.given, n.middle, n.family, n.suffix) for n in names],
            [("John", "Michael", "Smith", ""), ("Jane", "", "Doe", "Jr.")],
        )

    def test_organisation_author_kept_whole(self):
        names = ms.crossref_authors({"author": [{"name": "ATLAS Collaboration"}]})
        self.assertEqual(names[0].family, "ATLAS Collaboration")
        self.assertEqual(names[0].given, "")

    def test_fills_blank_fields_only(self):
        p = paper(self.db, doi="10.1/x", publication_year=2001,
                  abstract="An existing abstract that is long enough to count here ok.",
                  citation_count=7)
        changes = ms.plan_updates(p, msg())
        self.assertEqual(set(changes), {"authors"})  # year/abstract/count kept
        blank = paper(self.db, doi="10.1/y")
        changes = ms.plan_updates(blank, msg())
        self.assertEqual(changes["publication_year"], 2019)
        self.assertEqual(changes["citation_count"], 42)
        self.assertTrue(changes["abstract"].startswith("word word"))
        self.assertNotIn("<", changes["abstract"])
        self.assertNotIn("title", changes)  # a normal title stays

    def test_corrupted_title_replaced(self):
        p = paper(self.db, doi="10.1/z", title="]oc.htam[")
        self.assertEqual(ms.plan_updates(p, msg())["title"], "The Crossref Title")

    def test_authors_set_when_missing(self):
        p = paper(self.db, doi="10.1/a")
        self.assertEqual(len(ms.plan_updates(p, msg())["authors"]), 2)

    def test_initials_upgraded_for_the_same_people(self):
        p = paper(self.db, doi="10.1/b", author="J. Smith; J. Doe")
        changes = ms.plan_updates(p, msg())
        self.assertEqual(changes["authors"][0].given, "John")
        self.assertEqual(changes["authors"][0].middle, "Michael")

    def test_existing_initials_are_never_dropped(self):
        # "D. Randy Garrison": Crossref's "Randy" does not start with D,
        # so this is not safely the same name and nothing is rewritten.
        p = paper(self.db, doi="10.1/r", author="D. Randy Garrison")
        out = msg(author=[{"given": "Randy", "family": "Garrison"}])
        self.assertNotIn("authors", ms.plan_updates(p, out))

    def test_richer_existing_middle_is_kept(self):
        p = paper(self.db, doi="10.1/m", author="J. Quincy Smith")
        out = msg(author=[{"given": "John", "family": "Smith"}])
        better = ms.plan_updates(p, out)["authors"][0]
        self.assertEqual((better.given, better.middle), ("John", "Quincy"))

    def test_all_caps_crossref_names_are_title_cased(self):
        names = ms.crossref_authors({"author": [
            {"given": "CHRISTIAN", "family": "JOST"},
            {"given": "JR", "family": "O'NEIL"},
        ]})
        self.assertEqual((names[0].given, names[0].family), ("Christian", "Jost"))
        self.assertEqual(names[1].given, "JR")  # short caps stay: initials
        self.assertEqual(names[1].family, "O'Neil")

    def test_different_people_never_replace_existing(self):
        p = paper(self.db, doi="10.1/c", author="Alan Turing; Ada Lovelace")
        self.assertNotIn("authors", ms.plan_updates(p, msg()))

    def test_already_complete_authors_left_alone(self):
        p = paper(self.db, doi="10.1/d", author="John Michael Smith; Jane Doe Jr.")
        self.assertNotIn("authors", ms.plan_updates(p, msg()))

    def test_missing_middle_name_is_added_for_the_same_person(self):
        p = paper(self.db, doi="10.1/d2", author="John Smith; Jane Doe")
        better = ms.plan_updates(p, msg())["authors"]
        self.assertEqual(better[0].middle, "Michael")

    def test_needs_sync(self):
        no_doi = paper(self.db, author="J. Smith")
        self.assertFalse(ms.needs_sync(no_doi))
        initials = paper(self.db, doi="10.1/e", author="J. Smith", publication_year=2020,
                         abstract="x" * 60)
        self.assertTrue(ms.needs_sync(initials))
        complete = paper(self.db, doi="10.1/f", author="John Smith", publication_year=2020,
                         abstract="x" * 60)
        self.assertFalse(ms.needs_sync(complete))
        solo = paper(self.db, doi="10.1/g", author="Plato", publication_year=2020,
                     abstract="x" * 60)
        self.assertTrue(ms.needs_sync(solo))  # single-token name: Crossref may know more


class NotFoundTest(unittest.TestCase):
    def test_404_is_not_found_and_other_errors_are_failures(self):
        import urllib.error

        def make(code):
            def fetch(url):
                raise urllib.error.HTTPError(url, code, "x", {}, None)
            return fetch

        from unittest import mock

        self.assertIsNone(ms._lookup(make(404), "10.1/x"))
        with mock.patch.object(ms, "_sleep", lambda seconds: None):
            self.assertEqual(ms._lookup(make(500), "10.1/x"), "failed")
            self.assertEqual(ms._lookup(make(403), "10.1/x"), "failed")


class RetryTest(unittest.TestCase):
    def test_rate_limit_is_retried_then_succeeds(self):
        import urllib.error
        from unittest import mock

        calls = []

        def fetch(url):
            calls.append(url)
            if len(calls) < 3:
                raise urllib.error.HTTPError(url, 429, "slow down", {}, None)
            return {"message": {"title": ["ok"]}}

        with mock.patch.object(ms, "_sleep", lambda seconds: None):
            self.assertEqual(ms._lookup(fetch, "10.1/x"), {"title": ["ok"]})
        self.assertEqual(len(calls), 3)

    def test_persistent_rate_limit_is_a_failure(self):
        import urllib.error
        from unittest import mock

        def fetch(url):
            raise urllib.error.HTTPError(url, 429, "slow down", {}, None)

        with mock.patch.object(ms, "_sleep", lambda seconds: None):
            self.assertEqual(ms._lookup(fetch, "10.1/x"), "failed")


class SyncRunTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()

    def fetch_for(self, table):
        def fetch(url):
            doi = url.split("/works/")[1].replace("%2F", "/")
            value = table.get(doi)
            if value == "boom":
                raise OSError("offline")
            if value is None:
                raise OSError("404")
            return {"message": value}
        return fetch

    def test_updates_record_derived_fields_and_counts(self):
        a = paper(self.db, doi="10.1/a", author="J. Smith")
        b = paper(self.db, doi="10.1/b")
        c = paper(self.db, doi="10.1/c")
        seen = []
        out = ms.sync_metadata(
            self.db,
            fetch=self.fetch_for({"10.1/a": msg(author=[{"given": "John", "family": "Smith"}]),
                                  "10.1/b": msg(), "10.1/c": "boom"}),
            on_progress=lambda s, d, t: seen.append((d, t)),
        )
        self.assertEqual(out["considered"], 3)
        self.assertEqual(out["changed"], 2)
        self.assertEqual(out["failed"], 1)
        self.assertEqual(seen[0], (0, 3))
        self.assertEqual(seen[-1], (3, 3))

        self.db.expire_all()
        a = self.db.get(Paper, a.id)
        self.assertEqual(a.authors[0].given, "John")
        self.assertEqual(a.author, "John Smith")  # display string rebuilt
        b = self.db.get(Paper, b.id)
        self.assertEqual([x.family for x in b.authors], ["Smith", "Doe"])
        self.assertEqual(b.publication_year, 2019)
        self.assertIn("crossref", b.enrichment_notes)
        self.assertIsNotNone(b.prepared_text)

    def test_idempotent_second_run_changes_nothing(self):
        paper(self.db, doi="10.1/a")
        fetch = self.fetch_for({"10.1/a": msg()})
        self.assertEqual(ms.sync_metadata(self.db, fetch=fetch)["changed"], 1)
        again = ms.sync_metadata(self.db, fetch=fetch)
        self.assertEqual(again["changed"], 0)

    def test_force_includes_complete_papers_and_limit(self):
        paper(self.db, doi="10.1/a", author="John Smith; Jane Doe", publication_year=2020,
              abstract="x" * 60)
        paper(self.db, doi="10.1/b", author="John Smith; Jane Doe", publication_year=2020,
              abstract="x" * 60)
        fetch = self.fetch_for({"10.1/a": msg(), "10.1/b": msg()})
        self.assertEqual(ms.sync_metadata(self.db, fetch=fetch)["considered"], 0)
        self.assertEqual(ms.sync_metadata(self.db, fetch=fetch, force=True)["considered"], 2)
        self.assertEqual(ms.sync_metadata(self.db, fetch=fetch, force=True, limit=1)["considered"], 1)



class SyncJobApiTest(unittest.TestCase):
    def test_job_runs_metadata_then_index_and_reports(self):
        import time
        from unittest import mock

        from fastapi.testclient import TestClient

        from app import api

        def fake_sync(db, *, force, on_progress=None, **_):
            summary = {"considered": 4, "changed": 3, "not_found": 1,
                       "failed": 0, "fields": {"authors": 3}}
            on_progress(summary, 4, 4)
            return summary

        rebuilt = []
        client = TestClient(api.app)

        with mock.patch.object(api, "sync_metadata", fake_sync), \
             mock.patch.object(api, "rebuild_recommendation_data", lambda: rebuilt.append(1)), \
             mock.patch.object(api, "set_recommendation_index_stale", lambda stale: None), \
             mock.patch.object(api, "SessionLocal", lambda: mock.MagicMock()):
            started = client.post("/api/papers/sync", json={})
            self.assertEqual(started.status_code, 200)

            status = {}
            for _ in range(60):
                status = client.get("/api/papers/sync/status").json()
                if status["state"] != "running":
                    break
                time.sleep(0.05)

        self.assertEqual(status["state"], "done")
        self.assertEqual(status["changed"], 3)
        self.assertEqual(status["fields"], {"authors": 3})
        self.assertTrue(status["summary"]["index_rebuilt"])
        self.assertEqual(rebuilt, [1])
        self.assertIn("elapsed", status)

    def test_second_start_while_running_is_rejected(self):
        from fastapi.testclient import TestClient

        from app import api

        client = TestClient(api.app)
        api._sync_update(state="running")
        try:
            self.assertEqual(client.post("/api/papers/sync", json={}).status_code, 409)
        finally:
            api._sync_update(state="idle")


if __name__ == "__main__":
    unittest.main()
