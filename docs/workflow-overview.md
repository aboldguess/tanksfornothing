# Workflow Overview Documentation

<!--
File mini-readme: This Markdown document provides a quick-reference guide for collaborators about the development workflow within the repository. It is structured into sections covering branching, commit practices, code review preparation, and troubleshooting resources. Each section contains concise bullet points so maintainers can understand expectations at a glance.
-->

## Purpose
- Summarise the expected workflow when collaborating on the project.
- Capture conventions for branching, committing, and preparing pull requests.
- Provide quick access to debugging and support resources for new contributors.

## Branching Guidelines
- Create feature branches from the `work` branch using the pattern `feature/<short-description>`.
- Keep branches focused on a single logical change to simplify reviews and reduce merge conflicts.
- Regularly rebase against `work` to integrate upstream fixes before opening a pull request.

## Commit Practices
- Write descriptive commit messages using the format `type: summary`, where `type` is `feat`, `fix`, `docs`, `chore`, or `refactor`.
- Ensure each commit captures a coherent, buildable state with passing tests when applicable.
- Avoid committing secrets or credentials—add them to `.gitignore` and use environment variables instead.

## Pull Request Preparation
- Run the relevant linting and testing commands prior to submission and include their results in the PR description.
- Fill out the PR checklist to document testing, screenshots, and any follow-up tasks.
- Request reviews from domain owners when your change touches specialised areas such as networking or rendering.

## Debugging Resources
- Enable verbose logging via the existing configuration options to capture detailed runtime information.
- Use the setup scripts in the `src/scripts/` and `packages/server/src/scripts/` directories to initialise or reset data when diagnosing persistent issues.
- For complex problems, document the reproduction steps in the issue tracker to assist other maintainers.
