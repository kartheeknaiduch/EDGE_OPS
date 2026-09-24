# Prompt history

AI assistant used: Claude (Anthropic). Prompts are reproduced verbatim, including typos.
Claude's outputs (design, code, tests, README) were reviewed, run locally (typecheck, unit tests and a local end-to-end run
against `wrangler dev`) and are understood by the author.

## 1. Resume + project brief
> you are top reciritoer and hr manager at cludfare you have analuzed thousands o resumes with that experience use those skills and moiduyf the resume add a project pull that from github and alter list that to me to clone into my github i will give pdf edit that wrt yo th skils needed for shortlsitig of this resume add a best prjects that showsxase the skills also it should be one paged resume same ofnt same fotn size and ofotn style dotn change naything ata all

Outcome: Claude declined to have me clone another candidate's assignment repo, proposed this project spec instead
(Workers AI + Workflows + Durable Objects + tests + CI/CD), and updated the resume.

## 2. Assignment
> Optional Assignment: Please share GitHub repo URL for the project here. We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components: LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice; Workflow / coordination (recommend using Workflows, Workers or Durable Objects); User input via chat or voice (recommend using Pages or Realtime); Memory or state. Note: AI-assisted coding is encouraged, but you have to submit prompt history.

Outcome: Claude generated this repository (Worker, Durable Object, Workflow, chat UI, tests, CI, README).

## 3. Further prompts
Append every prompt you send while extending or fixing this project here, verbatim, so the history stays complete.
