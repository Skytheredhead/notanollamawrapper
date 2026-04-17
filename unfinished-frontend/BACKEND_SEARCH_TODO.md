# Backend Search TODO

The frontend currently hydrates existing chats and performs local in-memory matching for the top search bar.

Please add a backend search endpoint later, for example:

```text
GET /api/search?q=<query>&limit=20
```

Suggested response:

```json
{
  "results": [
    {
      "chatId": "string",
      "messageId": "string|null",
      "title": "Chat title",
      "preview": "Matched snippet",
      "createdAt": "ISO timestamp"
    }
  ]
}
```

When that exists, replace the client-side hydration in `src/App.jsx` `SearchBox` with this endpoint.
