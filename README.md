M2M — Read. Create. Publish.

An independent platform for discovering, reading, and publishing comics.

M2M is an independent comic publishing and reading platform built to bring readers and creators together in one place. It provides a space to discover new stories, enjoy a seamless reading experience, and publish original comics without depending on traditional publishing platforms.

Whether you're here to discover your next favourite series or share a story of your own, M2M aims to make comic publishing and reading more accessible.

---

✨ What is M2M?

M2M is designed around two communities:

- Readers — Discover comics, follow creators, build personal libraries, and enjoy a dedicated vertical reading experience.
- Creators — Publish original work, manage series and chapters, upload artwork, schedule releases, and understand their audience.

The platform also incorporates moderation, content classification, copyright reporting, and administrative tools to support a healthier publishing environment.

🚀 Features

📖 Reading & Discovery

- Explore and discover published comics.
- Search for series and creators.
- Dedicated vertical scrolling reader.
- Customizable reading experience.
- Reading progress and history.
- Bookmarks and personal library.
- Follow creators and series.
- Comments, likes, and engagement.

🎨 Creator Studio

- Create and manage comic series.
- Upload comic pages and artwork.
- Organize chapters and episodes.
- Manage drafts and publication status.
- Schedule chapter releases.
- Preview content before publishing.
- Access creator analytics.

👥 Community

- Reader and creator profiles.
- Creator following system.
- Comments and likes.
- Notifications and activity updates.
- Personal reading libraries.

🛡️ Content & Moderation

- Content ratings: General, Teen, and Mature (18+).
- Content warnings and descriptive tags.
- Reader-controlled mature-content filters.
- Restricted access to mature-rated content.
- Reporting and moderation workflows.
- Copyright infringement reporting.
- Administrative content management.

M2M does not intend to host prohibited sexual content or explicit pornography.

🛠️ Technology Stack

M2M uses a modern web architecture designed around managed backend services and scalable media delivery.

Layer| Technology
Frontend| Next.js
Language| TypeScript
Database| Supabase / PostgreSQL
Authentication| Supabase Auth
Backend| Cloudflare Workers
Media Storage| Cloudflare R2
Media Delivery| Cloudflare CDN
Source Control| GitHub

🏗️ Architecture

                 ┌──────────────────┐
                 │      M2M         │
                 │   Web Platform   │
                 └────────┬─────────┘
                          │
                 ┌────────▼─────────┐
                 │     Next.js      │
                 │   TypeScript     │
                 └────────┬─────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
     ┌────────▼────────┐     ┌────────▼────────┐
     │    Supabase     │     │ Cloudflare      │
     │                 │     │ Workers         │
     │ Authentication  │     │ API / Services  │
     │ PostgreSQL      │     └────────┬────────┘
     │ Database        │              │
     └─────────────────┘     ┌────────▼────────┐
                             │  Cloudflare R2  │
                             │  Comic Media    │
                             └─────────────────┘

💻 Getting Started

Prerequisites

Before setting up M2M, make sure you have:

- Node.js (compatible with the project dependencies)
- npm, pnpm, or Bun
- A Supabase project
- A Cloudflare account
- Cloudflare R2 configuration for media storage

1. Clone the repository

git clone https://github.com/YOUR_USERNAME/M2M.git
cd M2M

2. Install dependencies

Use the package manager corresponding to the project's lockfile.

bun install

Alternatively:

npm install

3. Configure environment variables

Create a ".env.local" file in the project root.

Add the environment variables required by the application, including the relevant Supabase and Cloudflare configuration.

Example:

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

SUPABASE_SERVICE_ROLE_KEY=

CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_BUCKET_NAME=

Important: This is an illustrative configuration template, not a verified complete environment-variable list. Check the project's actual configuration and Worker bindings before deployment.

Never commit ".env.local", service-role keys, database credentials, or private API secrets to GitHub.

4. Configure Supabase

1. Create a Supabase project.
2. Configure the database and authentication.
3. Apply the project's database migrations.
4. Configure Row Level Security (RLS).
5. Set up the required authentication providers and redirect URLs.

5. Configure Cloudflare

1. Configure the Cloudflare Worker.
2. Set up the required environment variables and secrets.
3. Configure the R2 bucket and access permissions.
4. Connect the media delivery configuration.
5. Verify the API and storage integrations.

6. Run the development server

bun run dev

Or:

npm run dev

Open:

http://localhost:3000

Check "package.json" for the project's available scripts.

---

🌍 Deployment

M2M is intended to use a GitHub-centred deployment workflow.

Service| Responsibility
GitHub| Source code and version control
Cloudflare| Application hosting, Workers, and media delivery
Supabase| Authentication and database
Cloudflare R2| Comic image and media storage

Production deployment requires configuring the actual environment, database migrations, Worker bindings, storage permissions, and domain settings.

🔐 Security

Security is an important part of M2M's architecture.

Areas covered by the platform's design include:

- Authentication and authorization.
- Database Row Level Security.
- Role-based access controls.
- Protected creator and administrative operations.
- Restricted media delivery.
- Content moderation and reporting.
- Secure handling of application secrets.

Security configuration and production readiness should be independently tested before public launch.

🗺️ Project Direction

M2M is being developed with an India-first launch approach, with the possibility of broader international availability in the future.

The long-term direction is to build an independent ecosystem where creators can publish their work and readers can discover stories without unnecessary barriers.

🤝 Contributing

Contributions, suggestions, and constructive feedback are welcome.

If you want to contribute:

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Test your implementation.
5. Submit a pull request describing your changes.

Please keep contributions focused, maintain existing architectural conventions, and avoid committing credentials or private configuration.

⚖️ Copyright & Content Ownership

Creators retain responsibility for the content they publish and must have the necessary rights or permissions to distribute it.

M2M is intended to support original comic publishing while providing mechanisms to report copyright violations and inappropriate content.

Do not upload copyrighted material without authorization.

📌 Project Status

M2M is under active development and pre-launch hardening.

Features, integrations, and deployment configurations may change as development progresses. Not all components should be considered production-ready until their functionality and security have been verified.

📄 License

A license has not yet been specified. All rights are reserved by the respective copyright holders unless a license is explicitly added to this repository.

---

<p align="center">M2M

Stories deserve a place of their own.

</p>