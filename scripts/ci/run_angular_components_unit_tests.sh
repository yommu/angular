#!/usr/bin/env bash
set -u -e -o pipefail

# Script that runs all unit tests of the `angular/components` repository.

# Path to the Angular project.
angular_dir=$(pwd)

# Switch into the temporary directory where the `angular/components`
# repository has been cloned into.
cd ${COMPONENTS_REPO_TMP_DIR}

# Create a symlink for the Bazel binary installed through NPM, as running through Yarn introduces OOM errors.
./scripts/circleci/setup_bazel_binary.sh

# Properly wire up the components repo CircleCI Bazel configuration
# Also enable RBE. The credentials are expected to be set up already.
echo "import %workspace%/.circleci/bazel.rc" >> ./.bazelrc.user
echo "build --config=remote" >> ./.bazelrc.user

# Now actually run the tests.
bazel test \
  --build_tag_filters=-docs-package,-e2e,-browser:firefox \
  --test_tag_filters=-e2e,-browser:firefox \
  --build_tests_only \
  --keep_going \
  -- src/...
