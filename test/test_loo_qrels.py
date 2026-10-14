import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.models import Base, Paper, PaperCitation
from app.services.evaluation import loo_qrels


def _paper(db, title, year=2020, doi=None, abstract="abstract text"):
    paper = Paper(
        title=title,
        author="A",
        abstract=abstract,
        keywords="kw",
        publication_year=year,
        doi=doi,
    )
    db.add(paper)
    db.flush()
    return paper


def _cite(db, paper, target, direction="cites", n=[0]):
    n[0] += 1
    db.add(
        PaperCitation(
            paper_id=paper.id,
            direction=direction,
            external_work_id=f"W{n[0]}",
            matched_paper_id=target.id if target else None,
        )
    )


class LooQrelsTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()

    def tearDown(self):
        self.db.close()

    def _corpus(self):
        db = self.db
        seed = _paper(db, "Graph neural networks for citation analysis", 2021)
        refs = [_paper(db, f"Reference paper number {i}") for i in range(4)]
        citer = _paper(db, "A later paper that cites the seed work")

        for ref in refs:
            _cite(db, seed, ref)

        _cite(db, seed, citer, "cited_by")
        _cite(db, seed, None)  # unresolved reference never counts
        db.commit()
        return seed, refs, citer

    def test_relevance_is_graded_and_excludes_unresolved(self):
        seed, refs, citer = self._corpus()
        queries = loo_qrels.build_loo_queries(self.db, min_refs=3)

        self.assertEqual(len(queries), 1)
        q = queries[0]
        self.assertEqual(q.seed_paper_id, seed.id)
        self.assertEqual(q.n_refs, 4)
        self.assertEqual(q.relevance[refs[0].id], 2)
        self.assertEqual(q.relevance[citer.id], 1)
        self.assertEqual(len(q.relevance), 5)
        self.assertIn("Graph neural networks", q.query)
        self.assertIn("abstract text", q.query)

    def test_seed_is_excluded_from_its_own_pool(self):
        seed, _, _ = self._corpus()
        q = loo_qrels.build_loo_queries(self.db)[0]
        self.assertIn(seed.id, q.excluded_ids)
        self.assertNotIn(seed.id, q.relevance)

    def test_duplicate_of_seed_is_excluded_and_not_relevant(self):
        seed, refs, _ = self._corpus()
        dupe = _paper(self.db, "Graph neural networks for citation analysis", 2021)
        _cite(self.db, seed, dupe)  # a reference that is really the seed
        self.db.commit()

        q = loo_qrels.build_loo_queries(self.db)[0]
        self.assertIn(dupe.id, q.excluded_ids)
        self.assertNotIn(dupe.id, q.relevance)

    def test_doi_duplicate_detected(self):
        a = _paper(self.db, "Alpha one title long enough", doi="10.1/x")
        b = _paper(self.db, "Completely different words here", doi="https://doi.org/10.1/X")
        self.assertEqual(loo_qrels.duplicate_ids_of(a, [a, b]), {b.id})

    def test_min_refs_filters(self):
        self._corpus()
        self.assertEqual(loo_qrels.build_loo_queries(self.db, min_refs=5), [])

    def test_paper_without_text_is_skipped(self):
        db = self.db
        seed = Paper(title="", author="A")
        db.add(seed)
        db.flush()
        for i in range(3):
            _cite(db, seed, _paper(db, f"Ref {i} long enough title"))
        db.commit()
        self.assertEqual(loo_qrels.build_loo_queries(db), [])

    def test_to_qrels_query(self):
        self._corpus()
        q = loo_qrels.build_loo_queries(self.db)[0]
        qq = q.to_qrels_query()
        self.assertEqual(qq.kind, "text")
        self.assertEqual(qq.relevance, q.relevance)

    def test_sampling_is_seeded_and_stratified(self):
        db = self.db
        for year in (2018, 2019, 2020):
            for s in range(3):
                seed = _paper(db, f"Seed {year} {s} distinct words {year}{s}", year)
                for r in range(3):
                    _cite(db, seed, _paper(db, f"Ref {year}-{s}-{r} unique title text"))
        db.commit()

        first = loo_qrels.build_loo_queries(db, n=3, seed=1)
        second = loo_qrels.build_loo_queries(db, n=3, seed=1)
        self.assertEqual(
            [q.seed_paper_id for q in first],
            [q.seed_paper_id for q in second],
        )
        self.assertEqual({q.year for q in first}, {2018, 2019, 2020})

    def test_invalid_arguments(self):
        with self.assertRaises(ValueError):
            loo_qrels.build_loo_queries(self.db, min_refs=0)
        with self.assertRaises(ValueError):
            loo_qrels.build_loo_queries(self.db, n=0)



class LinkReferenceRowsTest(unittest.TestCase):
    def test_references_get_matched_by_work_id(self):
        from app.services import citations

        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        seed = _paper(db, "Seed title long enough here", doi="10.1/seed")
        ref = _paper(db, "Reference title long enough", doi="10.1/ref")
        db.add_all([
            PaperCitation(paper_id=seed.id, direction="cites", external_work_id="W111"),
            PaperCitation(paper_id=seed.id, direction="cites", external_work_id="W999"),
        ])
        db.commit()

        def fetch(url):
            self.assertIn("filter=doi:", url)
            return {"results": [
                {"id": "https://openalex.org/W111", "doi": "https://doi.org/10.1/ref"},
                {"id": "https://openalex.org/W222", "doi": "https://doi.org/10.1/seed"},
            ]}

        result = citations.link_reference_rows(db, fetch=fetch)
        self.assertEqual(result["rows_linked"], 1)
        rows = {r.external_work_id: r.matched_paper_id
                for r in db.query(PaperCitation)}
        self.assertEqual(rows["W111"], ref.id)
        self.assertIsNone(rows["W999"])
        # Idempotent.
        self.assertEqual(citations.link_reference_rows(db, fetch=fetch)["rows_linked"], 0)

    def test_failed_batch_is_reported_not_raised(self):
        from app.services import citations

        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        _paper(db, "Only paper title long enough", doi="10.1/a")
        db.commit()

        def boom(url):
            raise OSError("offline")

        result = citations.link_reference_rows(db, fetch=boom)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failed_batches"], 1)



class CountEligibleTest(unittest.TestCase):
    def test_matches_exact_builder_and_is_fast_path(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]
        for s in range(3):
            seed = _paper(db, f"Seed {words[s]} paper about unrelated things {s}")
            for r in range(3 + s):
                ref = _paper(db, f"Reference {words[r]} {words[s]} study of topic {r}{s}")
                _cite(db, seed, ref)
        db.commit()

        for m in (1, 3, 4, 5, 6):
            self.assertEqual(
                loo_qrels.count_eligible(db, m),
                len(loo_qrels.build_loo_queries(db, min_refs=m)),
                f"min_refs={m}",
            )

        with self.assertRaises(ValueError):
            loo_qrels.count_eligible(db, 0)

    def test_self_and_unresolved_do_not_count(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        seed = _paper(db, "A seed paper with its own distinct title words")
        _cite(db, seed, seed)   # self-citation glitch
        _cite(db, seed, None)   # unresolved
        db.commit()
        self.assertEqual(loo_qrels.count_eligible(db, 1), 0)


if __name__ == "__main__":
    unittest.main()
