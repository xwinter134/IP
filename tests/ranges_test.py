"""Extractor tests:  python3 -I tests/ranges_test.py   (stdlib unittest, no corpus needed)"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline", "lib"))
import ranges_extract as RX  # noqa: E402

VOCAB = json.load(open(os.path.join(ROOT, "data", "seed", "range_params.json"), encoding="utf-8"))
COMP = dict((c["id"], i) for i, c in enumerate(VOCAB["components"]))


def ex(text, lang="en"):
    return RX.extract(text, VOCAB, lang)


def one(text, param=None, lang="en"):
    rows = [r for r in ex(text, lang) if param is None or r["param"] == param]
    assert len(rows) == 1, "expected one %s row in %r, got %r" % (param, text, [(r["param"], r["lo"], r["hi"]) for r in rows])
    return rows[0]


class T(unittest.TestCase):
    def rng(self, text, param, lo, hi, unit=None, lang="en", **kw):
        r = one(text, param, lang)
        self.assertEqual((r["lo"], r["hi"]), (lo, hi), text)
        if unit is not None:
            self.assertEqual(r["unit"], unit, text)
        for k, v in kw.items():
            self.assertEqual(r[k], v, "%s in %r" % (k, text))
        return r

    # ---- mol % ranges
    def test_from_about_to_about_mol(self):
        r = self.rng("comprising from about 30 to about 60 mol % of an ionizable lipid", "mol_pct", 30, 60, "mol%", approx=True)
        self.assertEqual(r["comp"], COMP["ionizable_cationic"])

    def test_between_and_percent(self):
        r = self.rng("comprising between 40% and 50% cholesterol", "mol_pct", 40, 50, "%")
        self.assertEqual(r["comp"], COMP["sterol"])

    def test_dash_mol(self):
        r = self.rng("and 30-60 mol% of the PEG lipid", "mol_pct", 30, 60, "mol%")
        self.assertEqual(r["comp"], COMP["peg"])

    def test_unit_both_sides(self):
        self.rng("an amount of 30 mol% to 60 mol% phospholipid", "mol_pct", 30, 60, "mol%")

    def test_mole_percent_spellings(self):
        for t in ("5 to 15 mole %", "5 to 15 mol. %", "5 to 15 mole percent", "5 to 15 molar percent", "5 to 15 percent by mole", "5 to 15 % mol"):
            self.rng("a phospholipid at " + t, "mol_pct", 5, 15, "mol%")

    def test_wt_percent(self):
        for t in ("1 to 5 wt %", "1 to 5 wt.%", "1 to 5% w/w", "1 to 5 weight percent", "1 to 5 % by weight"):
            self.rng("comprising " + t + " of the mRNA", "wt_pct", 1, 5, "wt%")

    def test_percent_without_mol(self):
        r = self.rng("the helper lipid is present at 5-25%", "mol_pct", 5, 25, "%")
        self.assertEqual(r["comp"], COMP["phospholipid_helper"])

    def test_percent_without_lipid_context_not_mol(self):
        self.assertEqual(ex("the yield is 5-25% of the starting material"), [])

    def test_open_upper(self):
        r = self.rng("less than 5 mol % of the sterol", "mol_pct", None, 5, "mol%")
        self.assertFalse(r["hiInc"])
        for t in ("no more than", "at most", "up to", "not more than", "not exceeding"):
            r = self.rng(t + " 5 mol % of the sterol", "mol_pct", None, 5)
            self.assertTrue(r["hiInc"], t)
        self.rng("below 5 mol % of the sterol", "mol_pct", None, 5)
        self.rng("<5 mol % of the sterol", "mol_pct", None, 5)
        self.rng("≤ 5 mol % of the sterol", "mol_pct", None, 5)

    def test_open_lower(self):
        r = self.rng("greater than 20 mol % ionizable lipid", "mol_pct", 20, None)
        self.assertFalse(r["loInc"])
        for t in ("at least", "no less than", "not less than", "a minimum of"):
            r = self.rng(t + " 20 mol % ionizable lipid", "mol_pct", 20, None)
            self.assertTrue(r["loInc"], t)
        self.rng("more than 20 mol % ionizable lipid", "mol_pct", 20, None)
        self.rng("≥ 20 mol % ionizable lipid", "mol_pct", 20, None)

    def test_suffix_comparators(self):
        r = self.rng("ionizable lipid at 50 mol % or more", "mol_pct", 50, None)
        self.assertTrue(r["loInc"])
        self.rng("ionizable lipid at 5 mol % or less", "mol_pct", None, 5)

    def test_single_about(self):
        r = self.rng("PEG lipid at about 1.5 mol %", "mol_pct", 1.5, 1.5, approx=True)
        self.assertTrue(r["loInc"] and r["hiInc"])

    def test_about_twice(self):
        self.rng("from about about 30 to about 60 mol% of the sterol", "mol_pct", 30, 60, approx=True)

    def test_list_of_values(self):
        rows = [r for r in ex("an ionizable lipid at about 40, 45 or 50 mol %") if r["param"] == "mol_pct"]
        self.assertEqual([(r["lo"], r["hi"], r["unit"]) for r in rows], [(40, 40, "mol%"), (45, 45, "mol%"), (50, 50, "mol%")])
        self.assertTrue(rows[0]["approx"])

    def test_component_per_item(self):
        rows = ex("comprising 40-50 mol% ionizable lipid, 5-15 mol% phospholipid, 30-45 mol% cholesterol and 0.5-3 mol% PEG-lipid")
        self.assertEqual([r["comp"] for r in rows if r["param"] == "mol_pct"], [COMP["ionizable_cationic"], COMP["phospholipid_helper"], COMP["sterol"], COMP["peg"]])

    def test_component_before_number(self):
        rows = [r for r in ex("the ionizable lipid at 40-50 mol%, the phospholipid at 5-15 mol%") if r["param"] == "mol_pct"]
        self.assertEqual([r["comp"] for r in rows], [COMP["ionizable_cationic"], COMP["phospholipid_helper"]])

    def test_total_is_fallback(self):
        r = self.rng("50 mol % of the total lipid", "mol_pct", 50, 50)
        self.assertEqual(r["comp"], COMP["total"])
        r = self.rng("50 mol % ionizable lipid of the total lipid", "mol_pct", 50, 50)
        self.assertEqual(r["comp"], COMP["ionizable_cationic"])

    def test_no_component(self):
        r = self.rng("in an amount of 5 to 10 mol %", "mol_pct", 5, 10)
        self.assertEqual(r["comp"], -1)

    # ---- ratios
    def test_np_ratio(self):
        r = self.rng("an N/P ratio of 3:1 to 10:1", "np_ratio", 3, 10)
        self.assertEqual(r["comp"], -1)
        self.rng("an N:P ratio of from about 4:1 to about 8:1", "np_ratio", 4, 8, approx=True)
        self.rng("an N/P ratio of 3 to 10", "np_ratio", 3, 10)
        self.rng("an N/P of 6", "np_ratio", 6, 6)

    def test_molar_ratio(self):
        self.rng("a molar ratio of ionizable lipid to PEG lipid of 1:1 to 10:1", "molar_ratio", 1, 10)
        self.rng("in a molar ratio of between 1:1 and 10:1", "molar_ratio", 1, 10)

    def test_ratio_one_to_ten(self):
        r = self.rng("molar ratio of 1:1 to 10:1", "molar_ratio", 1, 10)
        self.assertEqual(r["unit"], "")

    def test_weight_ratio(self):
        self.rng("a weight ratio of 10:1 to 30:1", "weight_ratio", 10, 30)
        self.rng("a lipid to mRNA mass ratio of from 10:1 to 30:1", "weight_ratio", 10, 30)

    def test_ratio_value_is_float(self):
        self.rng("a weight ratio of 1:4 to 1:2", "weight_ratio", 0.25, 0.5)

    def test_multipart_ratio_not_a_range(self):
        self.assertEqual(ex("in a molar ratio of 50:10:38.5:1.5"), [])

    def test_ratio_without_keyword_dropped(self):
        self.assertEqual(ex("mixed at 3:1 to 10:1"), [])

    # ---- particle properties
    def test_size(self):
        self.rng("having a diameter of 50 nm to 150 nm", "size_nm", 50, 150, "nm")
        self.rng("particles with a mean size of about 80 nm", "size_nm", 80, 80, "nm", approx=True)
        self.rng("a particle size of 0.1 to 0.2 µm", "size_nm", 100, 200, "nm")

    def test_nm_without_size_word_dropped(self):
        self.assertEqual(ex("absorbance measured at 260 nm"), [])

    def test_pdi(self):
        self.rng("a PDI of less than 0.2", "pdi", None, 0.2)
        self.rng("a polydispersity index of 0.05 to 0.2", "pdi", 0.05, 0.2)

    def test_pka(self):
        r = self.rng("the ionizable lipid has a pKa of 5.5 to 7.0", "pka", 5.5, 7)
        self.assertEqual(r["comp"], COMP["ionizable_cationic"])
        self.rng("a pKa between 6.2 and 6.5", "pka", 6.2, 6.5)

    def test_encapsulation(self):
        self.rng("an encapsulation efficiency of at least 80%", "encaps_pct", 80, None, "%")
        self.rng("at least 80% encapsulation efficiency", "encaps_pct", 80, None)

    def test_temperature_and_ph(self):
        self.rng("incubating at 20 to 25 °C", "temp_c", 20, 25, "C")
        self.rng("stored from -80 to -20 °C", "temp_c", -80, -20)
        self.rng("at a pH of 4.0-5.0", "ph", 4, 5)
        self.rng("at a pH below 5", "ph", None, 5)
        self.rng("storing at 2 °C to 8 °C", "temp_c", 2, 8)

    def test_chain_lengths(self):
        r = self.rng("each R is C12-C18 alkyl", "chain_c", 12, 18, "C")
        self.rng("a C1-C6 alkyl group", "chain_c", 1, 6)
        self.rng("a C12 to C18 alkyl chain", "chain_c", 12, 18)
        self.rng("an alkyl having 12 to 18 carbon atoms", "chain_c", 12, 18)
        self.rng("at least 12 carbon atoms", "chain_c", 12, None)
        self.rng("a C10-24 acyl chain", "chain_c", 10, 24)

    def test_lipid_name_is_not_chain(self):
        self.assertEqual([r for r in ex("the lipid C12-200 and C14-PEG") if r["param"] == "chain_c"], [])

    def test_peg_mw(self):
        r = self.rng("DMG-PEG2000", "peg_mw", 2000, 2000, "Da")
        self.assertEqual(r["comp"], COMP["peg"])
        self.rng("a PEG-lipid with PEG 2k", "peg_mw", 2000, 2000)
        self.rng("PEG having a molecular weight of 1000 to 5000 Da", "peg_mw", 1000, 5000, "Da")
        self.rng("PEG with a molecular weight of up to 5 kDa", "peg_mw", None, 5000)

    def test_molecular_weight_without_peg_dropped(self):
        self.assertEqual(ex("a polymer having a molecular weight of 1000 to 5000 Da"), [])

    def test_concentration(self):
        self.rng("mRNA at a concentration of 0.1 to 1 mg/mL", "conc", 0.1, 1, "mg/mL")
        self.rng("at 50 µg/mL", "conc", 0.05, 0.05, "mg/mL")
        self.rng("20 mM citrate", "conc", 20, 20, "mM")

    # ---- negatives and robustness
    def test_claim_references_are_not_ranges(self):
        for t in ("The composition of claim 1-3, wherein the lipid is a PEG lipid", "according to any one of claims 1 to 5",
                  "claims 1-3 and 5 mol % of", "as in claim 4 or 5"):
            self.assertEqual(ex(t), [], t)

    def test_seq_id_figure_example_not_ranges(self):
        self.assertEqual(ex("SEQ ID NO: 1-3 and FIG. 2-4 and Example 3-5"), [])

    def test_unicode_dashes_and_spaces(self):
        r = self.rng("an ionizable lipid at 30–60 mol%", "mol_pct", 30, 60)
        self.assertEqual(r["off"], r["q"].index("30") + (0 if r["off"] < 40 else r["off"] - 40))
        self.rng("an ionizable lipid at 30−60 mol%", "mol_pct", 30, 60)
        self.rng("an ionizable lipid at 30 to 60 mol %", "mol_pct", 30, 60)
        self.rng("a temperature of −80 to −20 °C", "temp_c", -80, -20)

    def test_thousands_separator(self):
        self.rng("PEG with a molecular weight of 1,000 to 5,000 Da", "peg_mw", 1000, 5000)

    def test_inverted_range_dropped(self):
        self.assertEqual([r for r in ex("an ionizable lipid at 60 to 30 mol%")], [])

    def test_out_of_bounds_dropped(self):
        self.assertEqual(ex("an ionizable lipid at 150 mol%"), [])
        self.assertEqual(ex("a pH of 30"), [])

    def test_quote_and_offset(self):
        text = "x" * 200 + " comprising from about 30 to about 60 mol % of an ionizable lipid " + "y" * 200
        r = one(text, "mol_pct")
        self.assertLessEqual(len(r["q"]), 160)
        self.assertIn(r["q"], text)
        self.assertEqual(text[r["off"]:r["off"] + r["ml"]], "about 30 to about 60 mol %")
        self.assertEqual(text.index(r["q"]) + min(r["off"], VOCAB["windows"]["quote_lead"]), r["off"])

    def test_empty_and_none(self):
        self.assertEqual(ex(""), [])
        self.assertEqual(ex(None), [])

    def test_several_params_in_one_claim(self):
        rows = ex("The nanoparticle of claim 1 having a diameter of 60-100 nm, a PDI below 0.2, an N/P ratio of 4:1 to 8:1 and 35-50 mol% ionizable lipid.")
        self.assertEqual(sorted(r["param"] for r in rows), ["mol_pct", "np_ratio", "pdi", "size_nm"])

    # ---- German
    def test_de_mol_zwischen(self):
        r = self.rng("enthaltend zwischen 40 und 50 Mol-% eines ionisierbaren Lipids", "mol_pct", 40, 50, "mol%", lang="de")
        self.assertEqual(r["comp"], COMP["ionizable_cationic"])

    def test_de_von_bis_decimal_comma(self):
        self.rng("mit einem Durchmesser von 50 nm bis 150 nm", "size_nm", 50, 150, "nm", lang="de")
        self.rng("einem PDI von 0,05 bis 0,2", "pdi", 0.05, 0.2, lang="de")

    def test_de_comparators_and_wt(self):
        self.rng("mindestens 80 Gew.-% Cholesterin", "wt_pct", 80, None, "wt%", lang="de")
        self.rng("einem pH-Wert von höchstens 5", "ph", None, 5, lang="de")
        self.rng("einer Temperatur von 20 bis 25 °C", "temp_c", 20, 25, lang="de")

    def test_de_claim_reference(self):
        self.assertEqual(ex("Zusammensetzung nach Anspruch 1-3", "de"), [])


    # ---- review fixes (T2 review)
    def test_structural_lipid_is_not_helper(self):
        rows = ex("40-50 mol % of the compound of Formula (I), 30-45 mol % of the structural lipid, 5-15 mol % of the phospholipid, 1-5 mol % of the PEG-lipid")
        rows = [r for r in rows if r["param"] == "mol_pct"]
        self.assertEqual([(r["lo"], r["hi"], r["comp"]) for r in rows],
                         [(40, 50, -1), (30, 45, -1), (5, 15, COMP["phospholipid_helper"]), (1, 5, COMP["peg"])])

    def test_list_members_share_component(self):
        rows = [r for r in ex("wherein the ionizable lipid is about 40, 45 or 50 mol %.") if r["param"] == "mol_pct"]
        self.assertEqual([(r["lo"], r["comp"]) for r in rows], [(40, COMP["ionizable_cationic"]), (45, COMP["ionizable_cationic"]), (50, COMP["ionizable_cationic"])])
        rows = [r for r in ex("about 40, 45 or 50 mol % of the sterol") if r["param"] == "mol_pct"]
        self.assertEqual([r["comp"] for r in rows], [COMP["sterol"]] * 3)

    def test_tolerance_is_a_range(self):
        r = self.rng("at a temperature of 65\u00b0C \u00b1 2\u00b0C", "temp_c", 63, 67)
        self.assertEqual(len([x for x in ex("at a temperature of 65\u00b0C \u00b1 2\u00b0C") if x["param"] == "temp_c"]), 1)
        self.rng("the sterol at 40 \u00b1 5 mol%", "mol_pct", 35, 45, "mol%")
        self.rng("a pKa of 6.2 +/- 0.2", "pka", 6, 6.4)

    def test_subscript_chain_lengths(self):
        self.rng("a C\u2081\u2082-C\u2081\u2088 alkyl chain", "chain_c", 12, 18)

    def test_np_ratio_mixed_end(self):
        r = self.rng("an N/P ratio of 4 to 6:1", "np_ratio", 4, 6)
        self.assertEqual(len([x for x in ex("an N/P ratio of 4 to 6:1") if x["param"] == "np_ratio"]), 1)

    # ---- two-sided ranges whose upper end carries its own comparator (one interval, both bounds kept)
    def test_to_less_than(self):
        self.rng("the pKa of the lipid is from 6.0 to less than 7.0", "pka", 6, 7, loInc=True, hiInc=False)
        self.rng("at a pH of about 0 to less than 6", "ph", 0, 6, hiInc=False)
        self.rng("the PEG lipid is present from 0.5 mol % to less than 3 mol %", "mol_pct", 0.5, 3, "mol%", hiInc=False)

    def test_more_than_and_less_than(self):
        r = self.rng("the PEG lipid is present at more than 0.5 mol % and less than 3 mol %", "mol_pct", 0.5, 3, "mol%", loInc=False, hiInc=False)
        self.assertEqual(r["comp"], COMP["peg"])

    def test_or_more_and_or_less(self):
        self.rng("the PEG lipid is present at 0.5 mol % or more and 3 mol % or less", "mol_pct", 0.5, 3, "mol%", loInc=True, hiInc=True)

    def test_greater_than_lower_end(self):
        self.rng("the PEG lipid is present at greater than 0.5 mol % to 3 mol %", "mol_pct", 0.5, 3, "mol%", loInc=False, hiInc=True)

    def test_reversed_bounds_joined(self):
        r = self.rng("the ionizable lipid is present at 50 mol % or less but not less than 40 mol %", "mol_pct", 40, 50, "mol%")
        self.assertEqual(r["comp"], COMP["ionizable_cationic"])
        self.rng("the PEG lipid is present in an amount of at least 0.5 mol % and in an amount of at most 3 mol %", "mol_pct", 0.5, 3, "mol%")

    def test_less_than_or_about(self):
        self.rng("a diameter in the range of about 100 nanometers to less than or about 1 micron", "size_nm", 100, 1000, "nm", hiInc=True)
        self.rng("a diameter of less than or about 6 microns", "size_nm", None, 6000, "nm", hiInc=True)

    def test_mixed_scale_units(self):
        self.rng("a diameter of 100 nm to 1 micron", "size_nm", 100, 1000, "nm")

    def test_abbreviated_unit_period(self):
        self.rng("stored at a temperature of greater than 0\u00b0 C. and less than 10\u00b0 C. for up to 1 year", "temp_c", 0, 10, loInc=False, hiInc=False)

    def test_alternatives_and_other_components_not_joined(self):
        rows = [r for r in ex("PEG lipid of at least 1 mol % or at most 3 mol %") if r["param"] == "mol_pct"]
        self.assertEqual(len(rows), 2)          # "or": alternatives stay two rows
        rows = [r for r in ex("at least 5 mol % of polymer Z and at most 10 mol % PEG lipid") if r["param"] == "mol_pct"]
        self.assertEqual(len(rows), 2)          # a different (unknown) component before the second value
        rows = [r for r in ex("cholesterol at 30 mol % and less than 5 mol % of PEG lipid") if r["param"] == "mol_pct"]
        self.assertEqual([(r["lo"], r["hi"]) for r in rows], [(30, 30), (None, 5)])


if __name__ == "__main__":
    unittest.main(verbosity=1)
