# How to contribute

We'd love to accept your patches and contributions to this project.

## Before you begin

### Getting Started

To set up your local development environment for contributing:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/google/adk-js.git
   cd adk-js
   ```

1. **Install dependencies**:

   ```bash
   npm install
   ```

1. **Build and test**: Ensure everything is working correctly:

   ```bash
   npm run build
   npm test
   ```

### Code Quality

To maintain high code quality and consistency:

1. **Linting**: Use ESLint to check for code quality issues.

   ```bash
   npm run lint
   ```

   To automatically fix some linting issues:

   ```bash
   npm run lint:fix
   ```

1. **Formatting**: Use Prettier for consistent code styling.

   ```bash
   npm run format
   ```

The project uses `husky` and `lint-staged` to automatically lint and format
your changes before each commit.

### Commit notation

Pull requests are squash merged, so the PR title becomes the commit subject on
`main`. `release-please` reads those subjects to pick the next version and
write the changelog, so the PR title must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>
```

- **Types**: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
  `revert`, `style`, `test`. `feat` cuts a minor release, `fix` and `perf` a
  patch, and the rest appear in the changelog only.
- **Breaking changes**: add `!` before the colon, as in `feat(core)!: ...`, or
  add a `BREAKING CHANGE: <what broke>` footer to the commit body.
- **Scope** is optional and free-form, but lowercase — `dev`, `workflow`,
  `sessions`. It groups the changelog, so `fix(Dev)` and `fix(dev)` would split
  into two sections.
- Keep the subject to 100 characters, and leave off the trailing period.

Examples:

```
fix(dev): stop dropping piped stdin lines
feat(core): implement Runner.runLive
refactor(workflow)!: collapse LLMAgentWrapper into LlmAgent
```

The `commit-convention` CI check enforces this on every pull request. To check
a subject before you open one:

```bash
node scripts/check_commit_message.mjs "fix(dev): stop dropping piped stdin lines"
```

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about)
(CLA). You (or your employer) retain the copyright to your contribution; this
simply gives us permission to use and redistribute your contributions as part
of the project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or
to sign a new one.

### Review our community guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google/conduct/).

## Contribution process

### Code reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.

## PR policy

### AI Generated code

It's ok to generate the first draft using AI but we would like code which has
gone through human refinement.

### TSDoc

We want our TSDocs to be concise and meaningful. Usually aligned with
adk-python.
