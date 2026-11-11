"""Export the chemistry inputs for pipeline/chem_build.cjs as plain TSV (Node has no parquet reader).

Reads   data/probe/surechembl/out/compounds_subset.parquet   (lipid_candidate rows)
        data/probe/surechembl/out/lipid_candidate_map.parquet (compound x publication x where-found)
        data/work/targets.parquet                             (publications known to the tool)
Writes  data/work/chem/_in/compounds.tsv   compound_id, smiles, inchi_key, mol_weight, n_patents_global
        data/work/chem/_in/pats.tsv        pn, family_id (0 = unknown)   sorted by pn; row number = pn index
        data/work/chem/_in/map.tsv         compound_id, pn index, where bits  sorted by compound, pn index
        data/work/chem/_in/export.json     counts

Where bits: 1 claims, 2 description, 4 abstract, 8 title, 16 image, 32 mol attachment.
SureChEMBL publication numbers (WO-2017075531-A1) are joined to targets.pn (WO2017075531A1) by removing
the dashes. Only publications present in targets.parquet are kept. Idempotent; a few seconds.

Usage: python3 pipeline/chem_export.py [--limit N] [--out DIR]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

import duckdb  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only the first N compounds (smoke run)")
    ap.add_argument("--out", default=None, help="chemistry work directory (default data/work/chem)")
    args = ap.parse_args()
    t0 = time.time()
    src = config.SURECHEMBL_DIR
    out = os.path.join(args.out or os.path.join(config.WORK, "chem"), "_in")
    os.makedirs(out, exist_ok=True)
    comp = os.path.join(src, "compounds_subset.parquet")
    cmap = os.path.join(src, "lipid_candidate_map.parquet")
    for p in (comp, cmap, config.TARGETS):
        if not os.path.exists(p):
            sys.exit("missing input: " + p)
    db = duckdb.connect()
    db.execute("SET threads=2")
    lim = f"LIMIT {args.limit}" if args.limit else ""
    db.execute(f"""CREATE TABLE c AS SELECT compound_id, smiles, inchi_key, mol_weight, n_patents_global
                   FROM read_parquet('{comp}') WHERE lipid_candidate AND smiles IS NOT NULL
                   ORDER BY compound_id {lim}""")
    db.execute(f"""CREATE TABLE m AS
        SELECT m.compound_id, t.pn, coalesce(t.family_id, nullif(m.family_id, -1), 0) AS family_id,
               (m.in_clms::INT) | (m.in_desc::INT << 1) | (m.in_abst::INT << 2) | (m.in_ttl::INT << 3)
               | (m.in_image::INT << 4) | (m.in_mol::INT << 5) AS bits
        FROM read_parquet('{cmap}') m
        JOIN (SELECT pn, any_value(family_id) family_id FROM read_parquet('{config.TARGETS}') GROUP BY pn) t
          ON t.pn = replace(m.patent_number, '-', '')
        JOIN c ON c.compound_id = m.compound_id""")
    db.execute("""CREATE TABLE p AS SELECT pn, max(family_id) family_id, row_number() OVER (ORDER BY pn) - 1 AS i
                  FROM m GROUP BY pn""")
    tsv = "(FORMAT CSV, DELIMITER '\t', HEADER false, QUOTE '')"
    db.execute(f"COPY (SELECT * FROM c ORDER BY compound_id) TO '{out}/compounds.tsv' {tsv}")
    db.execute(f"COPY (SELECT pn, family_id FROM p ORDER BY i) TO '{out}/pats.tsv' {tsv}")
    db.execute(f"""COPY (SELECT m.compound_id, p.i, bit_or(m.bits) FROM m JOIN p USING (pn)
                         GROUP BY 1, 2 ORDER BY 1, 2) TO '{out}/map.tsv' {tsv}""")
    n_all = db.execute(f"SELECT count(*), count(DISTINCT patent_number) FROM read_parquet('{cmap}')").fetchone()
    info = {
        "snapshot": config.SURECHEMBL_SNAPSHOT,
        "compounds": db.execute("SELECT count(*) FROM c").fetchone()[0],
        "publications": db.execute("SELECT count(*) FROM p").fetchone()[0],
        "links": db.execute("SELECT count(*) FROM (SELECT DISTINCT compound_id, pn FROM m)").fetchone()[0],
        "compounds_linked": db.execute("SELECT count(DISTINCT compound_id) FROM m").fetchone()[0],
        "map_rows_source": n_all[0], "publications_source": n_all[1],
        "targets": db.execute(f"SELECT count(*) FROM read_parquet('{config.TARGETS}')").fetchone()[0],
        "sec": round(time.time() - t0, 1),
    }
    with open(os.path.join(out, "export.json"), "w", encoding="utf-8") as f:
        json.dump(info, f)
    print(json.dumps(info))


if __name__ == "__main__":
    main()
