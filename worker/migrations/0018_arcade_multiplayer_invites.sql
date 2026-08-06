-- Each private Arcade invite needs to say which multiplayer game it opens.
-- Old short-lived invitations remain usable and open Whiteware IO.
ALTER TABLE arcade_lobby_invites ADD COLUMN game TEXT NOT NULL DEFAULT 'wio';
