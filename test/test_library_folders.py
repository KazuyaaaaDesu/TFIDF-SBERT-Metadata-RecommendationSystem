"""Library folders: the rules and the API."""

import os
import tempfile
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import (
    Base,
    LibraryFolderPaper,
    Paper,
    PersonalLibrary,
    User,
)
from app.services import library_folders as lf


def make_db():
    path = os.path.join(tempfile.mkdtemp(), "folders.db")
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    db = Session()
    user = User(username="a", email="a@b.c", password_hash="x")
    db.add(user)
    db.flush()
    papers = []

    for i in range(5):
        p = Paper(title=f"Paper number {i} about topic {i * 11}", author="A")
        db.add(p)
        db.flush()
        papers.append(p.id)

    for pid in papers[:4]:  # the last one is not saved
        db.add(PersonalLibrary(user_id=user.id, paper_id=pid))

    db.commit()

    return Session, db, user.id, papers


class FolderRulesTest(unittest.TestCase):
    def setUp(self):
        self.Session, self.db, self.uid, self.papers = make_db()

    def raises(self, status, fn, *a, **k):
        with self.assertRaises(lf.FolderError) as ctx:
            fn(*a, **k)
        self.assertEqual(ctx.exception.status, status, ctx.exception.message)

    def test_names_are_trimmed_and_validated(self):
        f = lf.create_folder(self.db, self.uid, "  Thesis   chapter 2 ")
        self.assertEqual(f.name, "Thesis chapter 2")
        self.raises(400, lf.create_folder, self.db, self.uid, "   ")
        self.raises(400, lf.create_folder, self.db, self.uid, "x" * 81)
        self.raises(400, lf.create_folder, self.db, self.uid, "bad\x00name")

    def test_sibling_names_are_unique_ignoring_case_but_not_across_parents(self):
        a = lf.create_folder(self.db, self.uid, "Reading")
        self.raises(409, lf.create_folder, self.db, self.uid, "reading")
        lf.create_folder(self.db, self.uid, "Reading", parent_id=a.id)  # a different parent: fine
        self.raises(409, lf.create_folder, self.db, self.uid, " READING ", a.id)

    def test_nesting_depth_is_limited(self):
        parent = None
        for i in range(lf.MAX_DEPTH):
            parent = lf.create_folder(self.db, self.uid, f"L{i}", parent.id if parent else None)
        self.raises(400, lf.create_folder, self.db, self.uid, "too deep", parent.id)

    def test_unknown_or_foreign_parent_is_404(self):
        self.raises(404, lf.create_folder, self.db, self.uid, "x", 9999)
        other = User(username="o", email="o@b.c", password_hash="x")
        self.db.add(other); self.db.commit()
        theirs = lf.create_folder(self.db, other.id, "Theirs")
        self.raises(404, lf.create_folder, self.db, self.uid, "x", theirs.id)
        self.raises(404, lf.update_folder, self.db, self.uid, theirs.id, name="mine")
        self.raises(404, lf.delete_folder, self.db, self.uid, theirs.id)

    def test_rename_and_move(self):
        a = lf.create_folder(self.db, self.uid, "A")
        b = lf.create_folder(self.db, self.uid, "B")
        lf.update_folder(self.db, self.uid, b.id, parent_id=a.id)
        self.assertEqual(self.db.get(type(b), b.id).parent_id, a.id)
        lf.update_folder(self.db, self.uid, b.id, name="Beta")
        self.assertEqual(self.db.get(type(b), b.id).name, "Beta")
        lf.update_folder(self.db, self.uid, b.id, parent_id=None)  # back to the top
        self.assertIsNone(self.db.get(type(b), b.id).parent_id)

    def test_a_folder_cannot_move_into_itself_or_its_descendants(self):
        a = lf.create_folder(self.db, self.uid, "A")
        b = lf.create_folder(self.db, self.uid, "B", a.id)
        c = lf.create_folder(self.db, self.uid, "C", b.id)
        self.raises(400, lf.update_folder, self.db, self.uid, a.id, parent_id=a.id)
        self.raises(400, lf.update_folder, self.db, self.uid, a.id, parent_id=c.id)

    def test_moving_checks_the_depth_of_the_whole_subtree(self):
        chain = None
        for i in range(lf.MAX_DEPTH - 1):
            chain = lf.create_folder(self.db, self.uid, f"D{i}", chain.id if chain else None)
        sub = lf.create_folder(self.db, self.uid, "Sub")
        lf.create_folder(self.db, self.uid, "SubChild", sub.id)  # Sub has height 1
        self.raises(400, lf.update_folder, self.db, self.uid, sub.id, parent_id=chain.id)

    def test_renaming_to_a_sibling_name_conflicts_but_to_itself_is_fine(self):
        a = lf.create_folder(self.db, self.uid, "A")
        lf.create_folder(self.db, self.uid, "B")
        self.raises(409, lf.update_folder, self.db, self.uid, a.id, name="b")
        lf.update_folder(self.db, self.uid, a.id, name="A")  # unchanged: no conflict with itself

    def test_membership_add_remove_is_idempotent_and_only_for_saved_papers(self):
        f = lf.create_folder(self.db, self.uid, "F")
        out = lf.set_membership(self.db, self.uid, f.id, [self.papers[0], self.papers[1], self.papers[4]], "add")
        self.assertEqual(out, {"changed": 2, "skipped": [self.papers[4]]})
        again = lf.set_membership(self.db, self.uid, f.id, [self.papers[0]], "add")
        self.assertEqual(again["changed"], 0)
        gone = lf.set_membership(self.db, self.uid, f.id, [self.papers[0], self.papers[2]], "remove")
        self.assertEqual(gone["changed"], 1)
        self.raises(400, lf.set_membership, self.db, self.uid, f.id, [1], "move")

    def test_a_paper_can_be_in_several_folders(self):
        a = lf.create_folder(self.db, self.uid, "A")
        b = lf.create_folder(self.db, self.uid, "B")
        for f in (a, b):
            lf.set_membership(self.db, self.uid, f.id, [self.papers[0]], "add")
        o = lf.overview(self.db, self.uid)
        self.assertEqual(o["memberships"][str(self.papers[0])], sorted([a.id, b.id]))

    def test_deleting_a_folder_removes_its_subtree_but_never_papers(self):
        a = lf.create_folder(self.db, self.uid, "A")
        b = lf.create_folder(self.db, self.uid, "B", a.id)
        keep = lf.create_folder(self.db, self.uid, "Keep")
        lf.set_membership(self.db, self.uid, b.id, [self.papers[0]], "add")
        lf.set_membership(self.db, self.uid, keep.id, [self.papers[1]], "add")
        self.assertEqual(lf.delete_folder(self.db, self.uid, a.id), 2)
        o = lf.overview(self.db, self.uid)
        self.assertEqual([f["name"] for f in o["folders"]], ["Keep"])
        self.assertEqual(self.db.query(PersonalLibrary).count(), 4)  # papers untouched
        self.assertEqual(self.db.query(LibraryFolderPaper).count(), 1)

    def test_removing_a_paper_from_the_library_clears_its_placements(self):
        f = lf.create_folder(self.db, self.uid, "F")
        lf.set_membership(self.db, self.uid, f.id, [self.papers[0]], "add")
        lf.clear_paper(self.db, self.uid, self.papers[0])
        self.db.commit()
        self.assertEqual(self.db.query(LibraryFolderPaper).count(), 0)

    def test_overview_counts_unfiled_and_heals_orphans(self):
        f = lf.create_folder(self.db, self.uid, "F")
        lf.set_membership(self.db, self.uid, f.id, [self.papers[0], self.papers[1]], "add")
        o = lf.overview(self.db, self.uid)
        self.assertEqual(o["unfiled"], 2)
        self.assertEqual(o["folders"][0]["paper_count"], 2)
        # a paper leaves the library without going through clear_paper
        self.db.query(PersonalLibrary).filter_by(paper_id=self.papers[0]).delete()
        self.db.commit()
        o = lf.overview(self.db, self.uid)
        self.assertEqual(o["folders"][0]["paper_count"], 1)
        self.assertEqual(self.db.query(LibraryFolderPaper).count(), 1)  # the orphan row is gone


class FolderApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app import api

        cls.Session, db, cls.uid, cls.papers = make_db()
        db.close()
        cls.api = api

        def override():
            d = cls.Session()
            try:
                yield d
            finally:
                d.close()

        api.app.dependency_overrides[api.get_session] = override
        # the API serves the default user: make the seeded one the default
        with cls.Session() as d:
            cls.default_id = api.get_or_create_default_user(d).id
            d.query(PersonalLibrary).update({PersonalLibrary.user_id: cls.default_id})
            d.commit()

        cls.client = TestClient(api.app)

    @classmethod
    def tearDownClass(cls):
        cls.api.app.dependency_overrides.clear()

    def test_routes_are_not_swallowed_by_the_paper_id_routes(self):
        self.assertEqual(self.client.get("/api/library/folders").status_code, 200)
        r = self.client.post("/api/library/folders", json={"name": "Inbox"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["name"], "Inbox")

    def test_full_flow(self):
        a = self.client.post("/api/library/folders", json={"name": "Flow"}).json()
        b = self.client.post("/api/library/folders", json={"name": "Child", "parent_id": a["id"]}).json()
        self.assertEqual(self.client.post("/api/library/folders", json={"name": "flow"}).status_code, 409)
        r = self.client.post(f"/api/library/folders/{b['id']}/papers", json={"paper_ids": self.papers[:2]})
        self.assertEqual(r.json()["changed"], 2)
        o = self.client.get("/api/library/folders").json()
        child = next(f for f in o["folders"] if f["id"] == b["id"])
        self.assertEqual((child["parent_id"], child["paper_count"]), (a["id"], 2))
        r = self.client.patch(f"/api/library/folders/{b['id']}", json={"name": "Renamed"})
        self.assertEqual(r.json()["name"], "Renamed")
        self.assertEqual(r.json()["parent_id"], a["id"])  # absent parent_id: unchanged
        r = self.client.patch(f"/api/library/folders/{b['id']}", json={"parent_id": None})
        self.assertIsNone(r.json()["parent_id"])  # explicit null: top level
        r = self.client.patch(f"/api/library/folders/{a['id']}", json={"parent_id": b["id"]})
        self.assertEqual(r.status_code, 200)  # b is no longer a's child
        self.assertEqual(self.client.patch(f"/api/library/folders/{b['id']}", json={"parent_id": a["id"]}).status_code, 400)
        self.assertEqual(self.client.delete(f"/api/library/folders/{b['id']}").json()["folders_removed"], 2)
        self.assertEqual(self.client.delete("/api/library/folders/99999").status_code, 404)

    def test_removing_a_paper_from_the_library_clears_it_from_folders(self):
        f = self.client.post("/api/library/folders", json={"name": "Clear"}).json()
        pid = self.papers[2]
        self.client.post(f"/api/library/folders/{f['id']}/papers", json={"paper_ids": [pid]})
        self.assertIn(str(pid), self.client.get("/api/library/folders").json()["memberships"])
        self.assertEqual(self.client.delete(f"/api/library/{pid}").json()["status"], "removed")
        self.assertNotIn(str(pid), self.client.get("/api/library/folders").json()["memberships"])


if __name__ == "__main__":
    unittest.main()
