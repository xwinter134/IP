// Names, synonyms and roles for the reference lipids in data/seed/ref_lipids_pubchem.json (keyed by its "name").
// Structures always come from the seed file (PubChem); this file only adds labels. CAS numbers and systematic
// names were written from general knowledge and were not re-verified against a registry: they are search
// conveniences, not evidence. role: ionizable | cationic | helper | sterol | peg.
module.exports = {
  'DLin-MC3-DMA': { role: 'ionizable', synonyms: ['MC3', 'D-Lin-MC3-DMA', 'DLin MC3 DMA', 'dilinoleylmethyl 4-dimethylaminobutyrate',
    '(6Z,9Z,28Z,31Z)-heptatriaconta-6,9,28,31-tetraen-19-yl 4-(dimethylamino)butanoate', 'CAS 1224606-06-7', '1224606-06-7'], note: 'Onpattro (patisiran) ionizable lipid' },
  'ALC-0315': { role: 'ionizable', synonyms: ['ALC0315', 'ALC 0315', '((4-hydroxybutyl)azanediyl)bis(hexane-6,1-diyl) bis(2-hexyldecanoate)',
    '[(4-hydroxybutyl)azanediyl]di(hexane-6,1-diyl) bis(2-hexyldecanoate)', 'CAS 2036272-55-4', '2036272-55-4'], note: 'Comirnaty (BNT162b2) ionizable lipid' },
  'SM-102': { role: 'ionizable', synonyms: ['SM102', 'SM 102', 'Lipid H', 'heptadecan-9-yl 8-((2-hydroxyethyl)(6-oxo-6-(undecyloxy)hexyl)amino)octanoate',
    'CAS 2089251-47-6', '2089251-47-6'], note: 'Spikevax (mRNA-1273) ionizable lipid' },
  'DLin-KC2-DMA': { role: 'ionizable', synonyms: ['KC2', 'DLin-K-C2-DMA', 'DLin KC2 DMA', 'XTC2', '2,2-dilinoleyl-4-(2-dimethylaminoethyl)-[1,3]-dioxolane',
    'CAS 1190197-97-7', '1190197-97-7'] },
  'C12-200': { role: 'ionizable', synonyms: ['C12 200', 'C12200', 'CAS 1220890-25-4', '1220890-25-4'], note: 'lipidoid' },
  'DOTAP': { role: 'cationic', synonyms: ['1,2-dioleoyl-3-trimethylammonium-propane', '1,2-dioleoyl-3-trimethylammonium propane', 'N-[1-(2,3-dioleoyloxy)propyl]-N,N,N-trimethylammonium',
    'CAS 132172-61-3', '132172-61-3'], note: 'permanently cationic' },
  'DSPC': { role: 'helper', synonyms: ['1,2-distearoyl-sn-glycero-3-phosphocholine', 'distearoylphosphatidylcholine', 'distearoyl phosphatidylcholine', 'CAS 816-94-4', '816-94-4'] },
  'cholesterol': { role: 'sterol', synonyms: ['Chol', 'cholest-5-en-3beta-ol', 'cholesterin', 'CAS 57-88-5', '57-88-5'] },
  'DOPE': { role: 'helper', synonyms: ['1,2-dioleoyl-sn-glycero-3-phosphoethanolamine', 'dioleoylphosphatidylethanolamine', 'dioleoyl phosphatidylethanolamine', 'CAS 4004-05-1', '4004-05-1'] },
  'DLinDMA': { role: 'ionizable', synonyms: ['DLin-DMA', '1,2-dilinoleyloxy-N,N-dimethyl-3-aminopropane', '1,2-dilinoleyloxy-3-dimethylaminopropane', 'CAS 871258-12-7', '871258-12-7'] },
  'DODMA': { role: 'ionizable', synonyms: ['1,2-dioleyloxy-N,N-dimethyl-3-aminopropane', '1,2-dioleyloxy-3-dimethylaminopropane', 'CAS 104162-47-2', '104162-47-2'] },
  'DMG-PEG 2000': { role: 'peg', synonyms: ['DMG-PEG2000', 'DMG PEG 2000', 'PEG2000-DMG', 'PEG-DMG', 'DMG-PEG', 'PEG2000 DMG',
    '1,2-dimyristoyl-rac-glycero-3-methoxypolyethylene glycol-2000', 'CAS 160743-62-4', '160743-62-4'],
    note: 'structure is a surrogate with the PEG chain cut to one unit; polymers have no discrete structure in the compound set' },
  'Lipid 5': { role: 'ionizable', synonyms: ['Lipid5', 'Moderna Lipid 5', 'heptadecan-9-yl 8-((2-hydroxyethyl)(8-(nonyloxy)-8-oxooctyl)amino)octanoate', 'CAS 2089251-33-0', '2089251-33-0'] },
  'DODAP': { role: 'ionizable', synonyms: ['1,2-dioleoyl-3-dimethylammonium-propane', '1,2-dioleoyl-3-dimethylammonium propane', 'CAS 127512-29-2', '127512-29-2'] },
  '98N12-5': { role: 'ionizable', synonyms: ['98N12-5(1)', '98N12 5', 'ND98'], note: 'lipidoid' },
  'cKK-E12': { role: 'ionizable', synonyms: ['cKKE12', 'cKK E12', 'MD-1', 'CAS 1432494-65-9', '1432494-65-9'], note: 'lipidoid' },
  'L319': { role: 'ionizable', synonyms: ['L-319', 'L 319', 'di((Z)-non-2-en-1-yl) 9-((4-(dimethylamino)butanoyl)oxy)heptadecanedioate', 'CAS 1351586-50-9', '1351586-50-9'] },
  'ATX-100': { role: 'ionizable', synonyms: ['ATX100', 'ATX 100'], note: 'Arcturus lipid family' }
};
