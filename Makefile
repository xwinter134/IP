# LNP FTO: rebuild and test. Downloads are never started from here (see README.md).
.PHONY: dist batches test e2e serve

dist:            ## normalize -> status -> chemistry (if stale) -> dist/ (base64 build, the publishable one)
	pipeline/run_all.sh build

batches:         ## list the publish batches of dist/
	pipeline/run_all.sh batches

test:            ## engine tests (Node only)
	node tests/search_test.mjs --no-browser
	node tests/chem_test.cjs
	node tests/fto_test.mjs

e2e:             ## end-to-end test of dist/ in headless Chromium behind a server that mimics the Artifact host
	node tests/e2e.cjs

serve:           ## serve dist/ like the Artifact host at http://127.0.0.1:8787
	node tests/artifact_server.cjs --port 8787
