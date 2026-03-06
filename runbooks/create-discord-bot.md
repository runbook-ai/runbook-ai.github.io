Your task is to help the user create a Discord bot application on the Discord Developer Portal, add it to their Discord account, and connect it on the Runbook AI bot page.

# Step 1: Create the bot on Discord Developer Portal

<subTask>
Navigate to https://discord.com/developers/applications.

Click the "New Application" button. In the modal that appears, enter a name for the bot (e.g. "RunbookAI Bot"). Check the box to agree to the Discord Developer Terms of Service and Developer Policy, then click "Create".

If a CAPTCHA appears, solve it.

After the application is created, you will land on the "General Information" page. Save the Application ID in memory.

Click "Bot" in the left sidebar to go to the Bot settings page. Scroll down and check the "Message Content Intent" checkbox, then click "Save Changes".

Now click "Bot" in the left sidebar again (if not already there). Click "Reset Token" to generate a new bot token. Save the token value in memory.

Navigate to the "Installation" section in the left sidebar. Find the install link displayed on the page (it will look like https://discord.com/oauth2/authorize?client_id=...). Store this link in memory.
</subTask>

# Step 2: Add the bot to user's Discord apps and open a DM

<subTask>
Navigate to the installation link you stored in Step 1.

On the authorization page, click "Add to My Apps". You may need to scroll down through the bot permissions details — scroll the content area until the "Authorize" button appears, then click "Authorize".

After authorization is complete, navigate to https://discord.com/users/application_id where application_id is from Step 1. Click on the message icon open a DM conversation. This confirms the bot is properly installed.

While you are on the DM page, find the Discord user name and save to memory.
</subTask>

# Step 3: Connect the bot on the Runbook AI bot page

<subTask>
Navigate to https://runbookai.net/bot/.

In the Settings section:
1. In the "Bot Token" input field, type the bot token you saved from Step 1.
2. In the "Allowed Users" textarea, type the Discord user name from Step 2.
3. Click the "Save Settings" button and verify the "OK Saved" confirmation appears.
4. Click the "Connect" button at the top of the page.
5. Verify that the status indicator changes from "Disconnected" to "Connected".
</subTask>

The bot is now set up and connected. The user can send DMs to the bot on Discord and it will be handled by the Runbook AI bot page.
