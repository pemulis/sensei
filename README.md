# Sensei
Framework for quickly developing and deploying AI guides. Geared toward rapid development and experimentation.

## Prerequisites

You have an [OpenAI API account](https://openai.com/blog/openai-api) and a [Heroku](https://signup.heroku.com/) account, and you have the `yarn`, `node`, and `heroku` packages installed on your machine. You will also need to have Postgres [installed locally](https://devcenter.heroku.com/articles/local-setup-heroku-postgres) and [Postgres CLI tools](https://postgresapp.com/documentation/cli-tools.html) set up.

## Getting started

1. `git clone https://github.com/pemulis/sensei.git`
2. `cd sensei`
3. `brew install jq` (if on Mac, otherwise [follow these instructions](https://jqlang.github.io/jq/download/))

## Creating a new branch

An easy way to create and deploy multiple AIs with different behavior is to create a new branch from `main` and then modify the `sensei.json` config and application code to suit your needs.

From the root of the directory:
1. `chmod +x branch.sh` (if you haven't done this already for an earlier branch)
2. `./branch.sh --name branchname --openai-key YOUR-OPENAI-API-KEY --session-secret YOUR-SESSION-SECRET --files "path/to/file1,path/to/file2"`

This will create and check out a new branch with that name, deploy it to Heroku, set it up with your OpenAI API key, add logging with the Logtail free plan, and a Heroku Postgres database under the Basic plan. Note: This will fail if the branch name is not unique.

To deploy changes to Heroku:
`git push branchname branchname:main`

To open the app from the command line:
`heroku open --app branchname`.

_Annoying sidenote:_ Only lowercase letters, digits, and dashes allowed for branch names. And since we want to use branch names as guide names—and hyphens are not allowed for Heroku config variables—that means no dashes. Just lowercase letters and digits. Sorry!

## Config options

The `sensei.json` config file allows you to set a few values.

Example:

```
{
  "target": "assistant",
  "model": "gpt-4-1106-preview",
  "branch": "kittycat",
  "systemPrompt": "You are a little kitty cat.",
  "guides": [
    {
      "name": "catfoodexpert",
      "description": "This AI guide knows all of the best types of cat food and can explain them in depth. The guide was deployed with the Sensei framework and makes its prompt endpoint publicly available without a login."
    },
    {
      "name": "cattoyexpert",
      "description": "This AI guide knows all of the best types of cat toys and can explain them in depth. The guide was deployed with the Sensei framework and makes its prompt endpoint publicly available without a login."
    }
  ]  
}
```

For the guides to work, you will need to define a URI endpoint with the same exact name in your environment variables. For example:

```catfoodexpert=https://cat-food-expert.com```

One of the main goals of Sensei is to make it easy to create _networks of guides_ who can assist each other. By creating a `catfoodexpert` guide with Sensei and deploying it, you can make its prompt endpoint available to other guides in your network. The URI endpoints for guides are stored as environment variables to shield them from the client side.

_Annoying sidenote:_ [No hyphens allowed](https://devcenter.heroku.com/articles/config-vars#config-var-policies) for Heroku config variables, and, therefore, no hyphens allowed for guide names.

Both the [Chat Completions API](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) and the [Assistants API](https://platform.openai.com/docs/assistants/overview) are supported as targets, but only the Assistants API is being actively tested right now. To use the Chat Completions API, change the value for `target` to `chat`.

For a given ["run"](https://platform.openai.com/docs/assistants/how-it-works/runs-and-run-steps) on the OpenAI side, the names of the external guides available to the root guide are appended to the system prompt to create the full instructions to pass to the run. In the example config, the full run instructions would read:

```You are a little kitty cat. These are the names of the specialized guides available to you through the callGuide function: catfoodexpert, cattoyexpert```

## Add guides from a script

You can use a shell script to add new guides.

1. `chmod +x addGuide.sh`
2. ```./addGuide.sh name1 "description1" uri1 name2 "description2" uri2```

This will add the guide names and descriptions to `sensei.json`, and the guide URIs as environment variables locally and on Heroku.

## Add files for knowledge retrieval

Guides using the Assistants API will automatically have access to any files you put in the `files` directory. Check OpenAI's [current documentation](https://platform.openai.com/docs/assistants/tools/supported-files) for filetypes compatible with Retrieval. It's mostly text files, PowerPoints, and PDFs for now; no image support yet.

## Add custom functions

You can add your own JavaScript functions and [function definitions](https://platform.openai.com/docs/assistants/tools/function-calling) to the `functions` directory. Guides using the Assistants API will automatically have access to them.

A few pointers:
1. Functions and their definitions must have the same name, besides the filetype.
2. Functions must have a .js filetype, while function definitions must be .json.
3. The better the `description` in the function definition, the better your guide will know when and how to call it.

### External API calls

If you need to call external APIs as part of your function, you need to add your API key as a an environment variable in Heroku. This is done for you automatically by `start.sh` for your OpenAI API key. For other API keys, set it in the web interface, or run this:

`heroku config:set NEW_API_KEY="{NEW_API_KEY}" --app "branchname"`

Your `branchname` was set when you created the branch. If you forget what it is, you can find it in `sensei.json` as the value for `branch`.

## Use GitHub workflows

You can use [GitHub](https://github.com/) to host your repository and set up CI before deploying to Heroku. There is a GitHub workflow file to tinker with in `.github/workflows`. 