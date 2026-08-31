# Channels

A [channel](../concepts/messaging.md#channels) is one service's conversation with a person. A service can carry more than a conversation. The same connection that carries messages can also let Rome act on the service. A service Rome only reads records from carries no conversation, and is not a channel however much of its data Rome holds.

Every channel answers the same three things. It carries messages both ways, it says who it can reach, and it says what was said there. What a channel cannot answer is a limit of its platform, never a limit of what has been built.

## Statements

- Every channel carries messages in both directions.
- A caller reads every channel through one interface and names no channel. Adding a channel changes no code above it.
- A channel says who it can reach, as far as its platform offers a directory.
- A channel says what was said on it, as far back as its platform lets Rome read.
- A channel says who it reaches and what was said on it without its message transport.
- A person reachable several ways on one channel is one account with one history.
