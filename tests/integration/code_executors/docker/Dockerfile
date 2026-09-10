# Multi-runtime image for the ContainerCodeExecutor integration tests.
#
# The executor dispatches each CodeExecutionLanguage to its own interpreter, so
# the test image must provide every one it maps: python3 (python), node
# (javascript), tsx (typescript) and sh (shell). The stock python:3-slim image
# only ships python3, which is why these tests need a dedicated image.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

# tsx type-strips and runs TypeScript in one step. The container has no network
# at run time, so it must be installed into the image ahead of time.
RUN npm install -g tsx@4
