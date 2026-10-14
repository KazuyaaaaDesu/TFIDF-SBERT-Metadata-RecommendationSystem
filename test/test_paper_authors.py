import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, Paper, PaperAuthor, _author_rows
from app.services.author_names import AuthorName, parse_author_list


class PaperAuthorSyncTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def _parts(self, paper):
        return [(a.given, a.middle, a.family, a.suffix) for a in paper.authors]

    def test_setting_author_string_creates_parts(self):
        paper = Paper(title="T", author="Smith, John Michael; Doe, Jane")
        self.db.add(paper)
        self.db.commit()

        self.assertEqual(
            self._parts(paper),
            [("John", "Michael", "Smith", ""), ("Jane", "", "Doe", "")],
        )
        # The display string the user typed is left untouched.
        self.assertEqual(paper.author, "Smith, John Michael; Doe, Jane")

    def test_editing_author_string_reparses(self):
        paper = Paper(title="T", author="John Smith")
        self.db.add(paper)
        self.db.commit()

        paper.author = "Jane Doe and Bob A. Roe"
        self.db.commit()

        self.assertEqual(
            self._parts(paper),
            [("Jane", "", "Doe", ""), ("Bob", "A.", "Roe", "")],
        )
        self.assertEqual(
            self.db.query(PaperAuthor).filter_by(paper_id=paper.id).count(), 2
        )

    def test_editing_parts_rebuilds_display_string(self):
        paper = Paper(title="T", author="John Smith")
        self.db.add(paper)
        self.db.commit()

        paper.authors = _author_rows(
            [AuthorName("Ada", "Augusta", "Lovelace"), AuthorName("Alan", "M.", "Turing")]
        )
        self.db.commit()

        self.assertEqual(paper.author, "Ada Augusta Lovelace; Alan M. Turing")
        self.assertEqual([a.position for a in paper.authors], [0, 1])

    def test_both_changed_parts_win(self):
        paper = Paper(title="T", author="Old Name")
        self.db.add(paper)
        self.db.commit()

        paper.author = "ignored string"
        paper.authors = _author_rows([AuthorName("Grace", "", "Hopper")])
        self.db.commit()

        self.assertEqual(paper.author, "Grace Hopper")
        self.assertEqual(self._parts(paper), [("Grace", "", "Hopper", "")])

    def test_clearing_author_removes_parts(self):
        paper = Paper(title="T", author="John Smith")
        self.db.add(paper)
        self.db.commit()

        paper.author = None
        self.db.commit()
        self.assertEqual(paper.authors, [])

    def test_no_author_no_rows_and_delete_cascades(self):
        bare = Paper(title="No author")
        withs = Paper(title="With", author="A B")
        self.db.add_all([bare, withs])
        self.db.commit()
        self.assertEqual(bare.authors, [])

        self.db.delete(withs)
        self.db.commit()
        self.assertEqual(self.db.query(PaperAuthor).count(), 0)

    def test_unrelated_edit_leaves_parts_alone(self):
        paper = Paper(title="T", author="John Smith")
        self.db.add(paper)
        self.db.commit()
        first_ids = [a.id for a in paper.authors]

        paper.title = "Changed"
        self.db.commit()
        self.assertEqual([a.id for a in paper.authors], first_ids)

    def test_backfill_structures_existing_strings_without_rewriting(self):
        from app import database

        # Rows stored before the table existed: author text, no parts.
        self.db.info["skip_author_sync"] = True
        self.db.add_all([
            Paper(title="A", author="Smith, John; Doe, Jane"),
            Paper(title="B", author=""),
            Paper(title="C"),
        ])
        self.db.commit()
        self.assertEqual(self.db.query(PaperAuthor).count(), 0)
        self.db.close()

        original = database.SessionLocal
        database.SessionLocal = self.Session
        try:
            self.assertEqual(database.backfill_authors(), 1)
            self.assertEqual(database.backfill_authors(), 0)  # idempotent
        finally:
            database.SessionLocal = original

        self.db = self.Session()
        paper = self.db.query(Paper).filter_by(title="A").one()
        self.assertEqual(paper.author, "Smith, John; Doe, Jane")  # untouched
        self.assertEqual([a.family for a in paper.authors], ["Smith", "Doe"])


if __name__ == "__main__":
    unittest.main()
