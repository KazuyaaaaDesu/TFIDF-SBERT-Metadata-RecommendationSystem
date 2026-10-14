"""
Offline evaluation utilities for the recommendation pipelines.

    - ``metrics``: pure information-retrieval metric functions.
    - ``qrels``: query relevance judgment loading, saving, and
      best-effort construction from OpenAlex.
    - ``runner``: pipeline-by-pipeline evaluation orchestration.
    - ``battle_log``: pure export (CSV / JSONL) and win-share
      statistics over the recorded Arena runs.
    - ``corpus_state``: the cached corpus size / version fingerprint
      each recorded run is stamped with.
"""
