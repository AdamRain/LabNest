# LabNest (研栖) Installation Prompt — English

[简体中文](INSTALL_PROMPT.zh-CN.md) · [Deployment guide](DEPLOYMENT.md)

Fill in the deployment details in brackets, then copy everything under “Copyable prompt” into an AI development assistant that can access the target machine. Leave any unknown details for the assistant to inspect or ask about. Enter passwords, SSH private keys, and email authorization codes securely on your own machine.

This is a deployment task template, not a record of a completed deployment.

## Copyable prompt

Please fully deploy LabNest (研栖) as our laboratory's production platform, accessible to both teachers and students.

Project repository: [https://github.com/AdamRain/LabNest](https://github.com/AdamRain/LabNest)

First read the repository's README.md, docs/DEPLOYMENT.md, and relevant configuration templates. Then deploy the platform according to the actual environment of the target machine.

My deployment details:

- Target machine: [This computer, or connection details for a remote server]
- Operating system: [Inspect it first if unknown]
- Access scope: [Local machine only / laboratory LAN / campus network / public internet]
- Website domain and certificate: [Provide existing details; leave blank if not yet available]
- First administrator's name and email: [Enter my own details]

If any information is incomplete, first inspect what you can determine automatically, then ask only for information that is genuinely missing. I will enter sensitive information, such as passwords, SSH private keys, and email authorization codes, securely on my own machine. Do not ask me to paste it into the chat.

Complete the following work:

1. Inspect the operating system, runtime environment, directory permissions, ports, and existing services. Select a published stable release and record its version. Back up any existing website, database, or configuration before making changes, and avoid overwriting it.
2. Install Node.js and dependencies as required by the project, and run the tests. Use a separate, empty database for the production site. Do not run Demo generation scripts, import demonstration data, or use the publicly shared Demo passwords.
3. Set up separate directories for code, data, configuration, and backups. Run the application under a non-administrator service account. Ensure that the startup, administrator creation, and backup commands always use the same production environment configuration and database.
4. Create the first administrator account with a unique, randomly generated password. Save the initial password in a local file readable only by me, and tell me its location in the handoff. Keep it out of public logs, screenshots, and the repository.
5. Configure the actual access URL and HTTPS. Follow the deployment guide to choose either direct TLS or a reverse proxy on the same machine, and configure proxy trust and cookies correctly. If the domain, certificate, or network requirements are not yet satisfied, complete the preparation work without exposing the service. Clearly explain what is missing, and do not lower the security requirements on your own.
6. Configure background operation, automatic restart after failures, and startup at boot. Check the firewall and access scope. Change only the settings required for this project, and keep other services running normally.
7. Configure scheduled backups for the database, email settings, and necessary configuration files, and document how to restore them. Enable password recovery by email after I provide the SMTP configuration. If SMTP is not yet configured, retain the configuration interface and list this as a pending task.
8. Perform acceptance testing with temporary test data: access through the actual URL, administrator sign-in, teacher and student registration and approval, supervisor-based access isolation, weekly report submission and revisions, attachments, replies to activity posts, the calendar, personal homepages, and CV export. Confirm that users awaiting approval cannot view internal information. Clearly distinguish test data from production data.

When finished, provide a concise handoff covering:

- The website URL, deployed version, and features that have been verified.
- The location of the file containing the administrator's initial password.
- How to start, stop, and restart the service, and view its logs.
- The locations of data, configuration, and backups, along with restoration instructions.
- The process for future updates, the rollback procedure, and anything I still need to handle.

Continue with all deployment work you can carry out. If administrator authorization, additional information, or external network configuration is required, explain the specific reason and what action is needed. Do not mark anything as complete unless it has been verified.
