import { useEffect, useMemo, useState } from "react";
import StaggerIn from "../components/retro/StaggerIn";
import "./faq.css";

const TOPICS = ["Basics", "Finding papers", "Your library", "Account"] as const;
type Topic = (typeof TOPICS)[number];
const TOPIC_OF: Topic[] = ["Basics", "Finding papers", "Finding papers", "Finding papers", "Your library", "Your library", "Account"];

const faqs = [
  {
    question: "What is Re:Search?",
    answer:
      "Re:Search is a paper repository and recommendation system for BulSU BSMCS students. It helps you search, discover, and organize research papers.",
  },
  {
    question: "How do I search for papers?",
    answer:
      "Open the Search page. Enter keywords, a research topic, or a paper title. The page ranks the papers that match your query. Open a result to read its record.",
  },
  {
    question: "How do I browse all available papers?",
    answer:
      "Open the Repository page. The page lists every paper in the system. Use the filters to limit the list.",
  },
  {
    question: "How do recommendations work?",
    answer:
      "Re:Search ranks papers with a recommendation pipeline. Select the pipeline on the Search page. The default pipeline combines three signals: TF-IDF, S-BERT, and metadata.",
  },
  {
    question: "How do I save a paper?",
    answer:
      "Select Save to library on a paper. The paper moves to My Library. Open My Library to read your saved papers again.",
  },
  {
    question: "How do I upload a paper?",
    answer:
      "Open the Upload page. Fill in the form, then select Upload. Re:Search stores the file and adds the paper to the repository.",
  },
  {
    question: "What happens when I sign out?",
    answer:
      "The sign-out ends your session and returns you to the sign-in page. Signing out does not delete the repository or your saved papers.",
  },
];

function useWide() {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [topic, setTopic] = useState<Topic | "All">("All");
  const [query, setQuery] = useState("");
  const wide = useWide();

  function toggleFAQ(index: number) {
    if (wide) {
      setOpenIndex(index);
      return;
    }
    setOpenIndex(openIndex === index ? null : index);
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return faqs
      .map((faq, index) => ({ faq, index, topic: TOPIC_OF[index] }))
      .filter(
        (row) =>
          (topic === "All" || row.topic === topic) &&
          (!q || `${row.faq.question} ${row.faq.answer}`.toLowerCase().includes(q)),
      );
  }, [topic, query]);

  const selected = wide
    ? visible.find((r) => r.index === openIndex) ?? visible[0] ?? null
    : null;
  const groups = TOPICS.map((t) => ({
    topic: t,
    rows: visible.filter((r) => r.topic === t),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="faq-page mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-6">
        <p className="text-sm font-bold text-muted">Help Center</p>

        <h1 className="font-pixelify mt-2 text-3xl font-bold leading-none text-ink">
          Frequently Asked Questions
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Answers to common questions about the Re:Search repository
          and recommendation system.
        </p>
      </div>

      <div className="faq-desk">
        <aside className="faq-list">
          <div className="faq-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search questions"
              aria-label="Search questions"
              className="faq-search-input"
            />
          </div>
          <div className="faq-chips" role="group" aria-label="Topics">
            {(["All", ...TOPICS] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={topic === t}
                onClick={() => setTopic(t)}
                className="faq-chip"
              >
                {t}
              </button>
            ))}
          </div>

          {groups.length === 0 && (
            <p className="faq-empty">No questions match.</p>
          )}

          {groups.map((g) => (
            <section key={g.topic} className="faq-group">
              <h2 className="faq-group-title">{g.topic}</h2>
              <ul>
                {g.rows.map(({ faq, index }, i) => {
                  const isOpen = wide ? selected?.index === index : openIndex === index;
                  return (
                    <li key={faq.question}>
                      <StaggerIn index={i}>
                        <div className="faq-ticket" data-open={isOpen}>
                        <button
                          type="button"
                          onClick={() => toggleFAQ(index)}
                          aria-expanded={isOpen}
                          className="faq-row"
                        >
                          <span className="faq-badge">{String(index + 1).padStart(2, "0")}</span>
                          <span className="faq-q">{faq.question}</span>
                          <span className="faq-plus" aria-hidden="true">+</span>
                        </button>
                        {!wide && isOpen && (
                          <div className="faq-inline">
                            <p className="text-sm leading-6 text-muted">{faq.answer}</p>
                          </div>
                        )}
                        </div>
                      </StaggerIn>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </aside>

        {wide && (
          <article className="faq-sheet" aria-live="polite">
            {selected ? (
              <>
                <p className="faq-sheet-meta">
                  Help sheet no. {String(selected.index + 1).padStart(2, "0")} · {selected.topic}
                </p>
                <h2 className="faq-sheet-title">{selected.faq.question}</h2>
                <p className="faq-sheet-body">{selected.faq.answer}</p>
                <p className="faq-sheet-foot">
                  Still stuck? Use the System Tutorial from the account menu.
                </p>
              </>
            ) : (
              <p className="faq-empty">Pick a question to read its answer.</p>
            )}
          </article>
        )}
      </div>

      {/* Bottom note */}
      <div className="faq-note mt-8">
        <p className="text-sm font-medium text-ink">Need more help?</p>

        <p className="mt-1 text-sm leading-5 text-muted">
          Use the System Tutorial from the account menu for a quick walkthrough
          of the main Re:Search features.
        </p>
      </div>
    </div>
  );
}
