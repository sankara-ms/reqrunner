/** `reqrunner.newFile`: opens a new `.reqrunner` document with a starter template. */
import * as vscode from 'vscode';

export const STARTER_TEMPLATE = `# ReqRunner request file
# Run a block with the "▶ Send Request" lens above it, or press Ctrl+Alt+R.
# Values in {{braces}} come from .reqrunner.env.json or from @name = value below.

@baseUrl = https://jsonplaceholder.typicode.com

### Get all posts

GET {{baseUrl}}/posts

Accept: application/json

### Get a single post

GET {{baseUrl}}/posts/1

Accept: application/json

### Create a post

POST {{baseUrl}}/posts

Content-Type: application/json

{
  "title": "ReqRunner",
  "body": "Sent straight from VS Code",
  "userId": 1
}

### Update a post

PUT {{baseUrl}}/posts/1

Content-Type: application/json

{
  "id": 1,
  "title": "Updated title",
  "body": "Updated body",
  "userId": 1
}

### Delete a post

DELETE {{baseUrl}}/posts/1
`;

export async function newFileCommand(): Promise<vscode.TextEditor | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument({
      content: STARTER_TEMPLATE,
      language: 'reqrunner'
    });
    return await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ReqRunner: could not create the file — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}
