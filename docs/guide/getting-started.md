# Getting started

MutinyBIM is a free, open-source building model you open in a browser. This
page walks through the hosted app: making an account, your list of models,
opening one in the editor, sharing it, and your settings.

The hosted app is at `https://app.mutinybim.com`. Anyone running their own
copy uses their own address; everything below works the same there.

## Make an account or log in

On the home page, press **Create a free account** or **Log in**.

To make an account, fill in:

- **Your name.** People editing with you see it.
- **Email.**
- **Password.** At least 8 characters.

Tick the box to agree to the Terms of use and the Privacy notice, then press
**Create account**.

Some servers also offer a sign-in provider. If yours does, its button
("Log in with …") sits above the email form, and you can use it instead of a
password. If a server has closed sign-ups, the sign-up page says
"Sign-ups are closed for now" and you can only log in to an existing account.

### If you forget your password

The app sends no email. **Forgot your password?** on the log-in page lists
the two ways back in:

- If you linked a sign-in provider to your account, log in with it, then set
  a new password under **Settings → Password**. No old password is needed for
  ten minutes after that sign-in.
- Otherwise, ask whoever runs the server for a reset link. It works once,
  for one hour. Setting a new password with it signs you out everywhere else.

## My models

After you log in you land on **My models**. The bar at the top of every
signed-in page has **My models**, **Connect an assistant**, **Settings**,
**Approvals**, a theme switch (**Light**, **Dark**, **Auto**) and
**Log out**.

<!-- screenshot: My models page with the Yours card and the New model form -->

The page has these parts:

- **Yours.** The models you own, each with when it last changed. The card
  also shows how many you have and how many a free account can keep.
- **Shared with you.** Models other people shared with you, with whose they
  are and a **Can edit** or **View only** badge. Only the owner can share,
  rename or delete these. This card shows only once something is shared
  with you.
- **New model.** A form to make another one.

### Make a model

Under **New model**, type a **Name**, then pick what to **Start from**:

- **A blank model with one level.**
- **The sample mechanical model (an air handler with ducts and diffusers).**
  Use it to look around before you draw anything.

Press **Make the model**. When you reach the most models a free account can
keep, the form is replaced by a note; delete one to make another.

### Rename or delete a model

Each of your models has four buttons: **Open**, **Share**, **Rename** and
**Delete**.

- **Rename** opens a small box with the current name. Change it and press
  **Save**.
- **Delete** asks first. People editing the model are disconnected and lose
  access, and it can't be undone from here.

## Open a model

Press **Open** (or the model's name). The model opens in the editor, on the
plan view.

The slim bar above the editor has:

- **← My models**, the way back to your list.
- The model's name, and whose it is when it was shared with you.
- A **View only** badge when the owner shared it with you to view. Edits are
  refused.
- The theme switch.
- **Ask AI** (below).
- **Connect an assistant**, which opens the page for connecting your own
  assistant app.

The theme you pick is kept in your account, so My models and the editor
match.

For what is inside the editor, see [A tour of the editor](editor-tour.md).

## Share a model

Only the owner can share. On My models, press **Share** beside the model.

<!-- screenshot: Share page with Who has it and Add someone -->

The share page has two cards:

- **Who has it.** You, marked **Owner**, and each person you shared with.
  Change what someone can do with the drop-down (**View only** or
  **Can edit**) and press **Change**. **Remove** stops sharing with them
  (it asks first, and they are disconnected at once).
- **Add someone.** Type **Their account email**, pick what they **Can** do
  (**Edit** or **View only**), and press **Share**.

What the two choices mean, in the app's words:

- **Can edit** lets them change the model, make branches and save versions.
- **View only** lets them look and nothing else.

The person needs a MutinyBIM account on the same server. The app sends no
email, so tell them yourself. They find the model under **Shared with you**
on their My models page. People editing the same model see each other's
changes live.

## Settings

**Settings** in the top bar has three cards.

### Your account

Your email, and your **Name**. Change the name and press **Save name**.

If the server offers sign-in providers, **Ways to log in** lists each one as
**Linked** or **Not linked**, with **Link it** to link one.

### Password

Type your **Current password** and a **New password** (at least 8
characters), then press **Change password**. Changing it signs you out on
every other device.

If you only ever signed in through a linked provider, this card says so and
the button reads **Set password**, so you can also log in with your email.

### Your AI

The app pays for no AI. To use the **Ask AI** button in the editor, paste a
key from your own AI provider here.

1. Pick a **Provider**: Anthropic (Claude), OpenAI (ChatGPT models), xAI
   (Grok), or another provider with an OpenAI-style address. For the last
   one, also fill in its **Address** (it ends in `/v1`).
2. Leave **Model** blank for the provider's usual one, or type a model name.
3. Paste your **API key**.
4. Press **Save in this browser**. **Test the key** checks it.
   **Forget the key** removes it.

The key is kept only in this browser. It is never sent to the server, never
saved in your account and never in the server's logs. Your browser sends
your questions straight to your provider, and the provider bills you.
Because the key lives in the browser, you add it again on each computer or
browser you use.

## Ask AI

In the editor, press **Ask AI** in the bar above the model. A panel opens.

<!-- screenshot: the Ask AI panel open over the editor -->

- With no key saved in this browser, the panel tells you to add one in
  **Settings → Your AI**, or to connect your assistant app instead.
- With a key, type a question and press **Ask** (or Ctrl+Enter, or
  Cmd+Enter on a Mac). **Stop** cancels a question that is still waiting.
  **Close** or Esc closes the panel.

Ask AI sees a summary of the model (how many elements of each kind, the
levels and the number of connections), not the drawing. It answers
questions; it does not change the model. To let an assistant read and
change the model, connect it: see
[Connect Claude or another assistant](connect-claude.md).

## Next

- [A tour of the editor](editor-tour.md)
- [Connect Claude or another assistant](connect-claude.md)
