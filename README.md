# Sensei
Framework for quickly developing and deploying AI guides. Geared toward rapid development and experimentation.

## Prerequisites

You have an [OpenAI API account](https://openai.com/blog/openai-api) and a [Heroku](https://signup.heroku.com/) account, and you have the `yarn`, `node`, and `heroku` packages installed on your machine. You will also need to have Postgres [installed locally](https://devcenter.heroku.com/articles/local-setup-heroku-postgres) and [Postgres CLI tools](https://postgresapp.com/documentation/cli-tools.html) set up.

## Steps to get started

1. `git clone https://github.com/pemulis/sensei.git`
2. `cd sensei`
3. `brew install jq` (if on Mac, otherwise [follow these instructions](https://jqlang.github.io/jq/download/))
4. `chmod +x start.sh`
5. `./start.sh {project-name} {OPENAI-API-KEY} {SESSION-SECRET}`

This will create and check out a new project with that name, deploy it to Heroku, set it up with your OpenAI API key, add logging with the Logtail free plan, and a Heroku Postgres database under the Basic plan. Note: This will fail if the project name is not unique.

To deploy changes to Heroku:
`git push {project-name} {project-name}:main`

To open the app from the command line:
`heroku open --app {project-name}`.

## Config options

The `sensei.json` config file allows you to set a few values: `target`, `model`, and `systemPrompt`.

Example:

```
{
  "target": "assistant",
  "model": "gpt-4-1106-preview",
  "branch": "kitty-cat",
  "systemPrompt": "You are a little kitty cat."
}
```

Both the [Chat Completions API](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) and the [Assistants API](https://platform.openai.com/docs/assistants/overview) are supported as targets. To use the Chat Completions API, change the value for `target` to `chat`.

## Add files for knowledge retrieval

Guides using the Assistants API will automatically have access to any files you put in the `files` directory. Check OpenAI's [current documentation](https://platform.openai.com/docs/assistants/tools/supported-files) for filetypes compatible with Retrieval. It's mostly text files, PowerPoints, and PDFs for now; no image support yet.

## Add custom functions

You can add your own JavaScript functions and [function definitions](https://platform.openai.com/docs/assistants/tools/function-calling) to the `functions` directory. Guides using the Assistants API will automatically have access to them.

A few pointers:
1. Functions and their definitions must have the same name, besides the filetype.
2. Functions must have a `.js` filetype, while function definitions must be `.json`.
3. The better the `description` in the function definition, the better your guide will know when and how to call it.

### External API calls

If you need to call external APIs as part of your function, you need to add your API key as a an environment variable in Heroku. This is done for you automatically by `start.sh` for your OpenAI API key. For other API keys, set it in the web interface, or run this:

`heroku config:set NEW_API_KEY="{NEW_API_KEY}" --app "{PROJECT_NAME}"`

Your `PROJECT_NAME` was set when you created the project. If you forget what it is, you can find it in `sensei.json` as the value for `branch`.

## Create a new branch

An easy way to create and deploy multiple AIs with different behavior is to create a new branch from `main` and then modify the `sensei.json` config and application code to suit your needs.

From the root of the directory:
1. `chmod +x branch.sh`
2. `./branch.sh {branch-name} {OPENAI-API-KEY} {SESSION-SECRET}`

The `./branch.sh` script is basically the same as the `./start.sh` script, but skips running `yarn` and `heroku login`. Just like project names, the branch name must be unique to deploy successfully to Heroku.

## Use GitHub workflows

You can use [GitHub](https://github.com/) to host your repository and set up CI before deploying to Heroku. There is a GitHub workflow file to tinker with in `.github/workflows`. 