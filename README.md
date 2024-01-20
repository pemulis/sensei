# sensei
framework for quickly developing and deploying AI agents

## Prerequisites

You have an [OpenAI API account](https://openai.com/blog/openai-api) and a [Heroku](https://signup.heroku.com/) account, and you have the `yarn`, `node`, and `heroku` packages installed on your machine.

## Steps to get started

1. `git clone https://github.com/pemulis/sensei.git`
2. `cd sensei`
3. `yarn`
4. `heroku login`
5. `heroku create`
6. `heroku config:set OPENAI_API_KEY={YOUR-KEY}`
7. `git push heroku main`
8. `heroku open`

## Config options

The `sensei.json` config file allows you to set a few values: `target`, `model`, and `systemPrompt`.

Example:

```
{
  "target": "chat-completions",
  "model": "gpt-4-1106-preview",
  "systemPrompt": "You are a little kitty cat."
}
```

Currently only the [Chat Completions API](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) is supported as a target, but we want to add support for the Assistants API soon.

## Create a new agent in a new branch

An easy way to create and deploy multiple AI agents with different behavior is to create a new branch from `main` and then modify the system prompt and `index.html` file to your liking. You can also add custom functionality to `app.js`.

Since you will now have multiple apps, you will need to reference them by name. The git push method will also change, since you will be working from a side branch but Heroku wants you to push to a main branch.

1. `git checkout -b {your-branch-name}`
2. `heroku create {your-branch-name}`
3. `heroku config:set OPENAI_API_KEY={YOUR-KEY} --app {your-branch-name}`
4. `git remote add {your-branch-name} https://git.heroku.com/{your-branch-name}.git`
4. `git push {your-branch-name} {your-branch-name}:main`
5. `heroku open {your-branch-name}`

## Optional: use the command line interface

1. `touch .env`
2. add `OPENAI_API_KEY={YOUR-KEY}` to `.env`
3. `node prompt.js`

## Optional: use GitHub workflows

Use [GitHub](https://github.com/) to host your repository and set up CI before deploying to Heroku. There is a GitHub workflow file you can tinker with. 