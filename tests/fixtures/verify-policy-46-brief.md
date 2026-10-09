Implement ticket #46: allow projects to require automated tests without a container verification environment.

Read the project instructions, add verify_policy validation, and retain exact-head CI before merge. Run the Python and Node suites and retain passing evidence for review.

Verification environment: local-tests
Run all project-required automated tests and retain complete passing evidence. Independent review and exact-head CI are required before merge. After review passes, go to report without a separate verify, browser or accessibility stage. Missing, failed or incomplete test evidence is not passing.