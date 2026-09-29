import os
import glob
import re

def process_html_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove developers link from header and footer and menus
    content = re.sub(r'<a[^>]*href="developers\.html"[^>]*>.*?</a>', '', content)
    content = re.sub(r'<li>\s*<a[^>]*href="developers\.html[^"]*"[^>]*>.*?</a>\s*</li>', '', content)
    content = re.sub(r'<a href="#page-developer".*?</a>', '', content)
    content = re.sub(r'<span class="label label--sdk">Developers</span>', '', content)
    
    # Remove developer sections in terms, etc.
    content = re.sub(r'<h4[^>]*>Developers</h4>\s*<ul>.*?</ul>', '', content, flags=re.DOTALL)

    # 2. Update to "Wild Rift", 4+ people
    content = re.sub(r'4 or 8 players', '4 or more players', content, flags=re.IGNORECASE)
    content = re.sub(r'any game', 'Wild Rift', content, flags=re.IGNORECASE)
    content = re.sub(r'27 games', 'Wild Rift', content, flags=re.IGNORECASE)
    content = re.sub(r'the game you play', 'Wild Rift', content, flags=re.IGNORECASE)
    content = re.sub(r'video games', 'Wild Rift', content, flags=re.IGNORECASE)
    
    # 3. Stripe instead of crypto/rcoin
    content = re.sub(r'rcoin', 'USD', content, flags=re.IGNORECASE)
    content = re.sub(r'simulated rcoin, no real money yet', 'simulated USD via Stripe test mode', content, flags=re.IGNORECASE)
    content = re.sub(r'simulated rcoin, no real money\.', 'simulated USD via Stripe test mode.', content, flags=re.IGNORECASE)
    
    # 4. Remove developer API section in console.html and index.html
    # In console.html: <section class="page" id="page-developer" hidden> ... </section>
    content = re.sub(r'<section class="page" id="page-developer" hidden>.*?</section>', '', content, flags=re.DOTALL)
    # In index.html: Developer teaser
    content = re.sub(r'<!-- Developer teaser -->.*?<!-- CTA -->', '<!-- CTA -->', content, flags=re.DOTALL)
    # Developer tools card in index
    content = re.sub(r'<div class="card"[^>]*>\s*<h3 class="card__title">Developer tools</h3>.*?</div>', '', content, flags=re.DOTALL)
    
    # 5. Remove "Free friendlies"
    content = re.sub(r'<li>Free friendlies whenever you just want to play</li>', '', content)
    
    # Save back
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

html_files = glob.glob('src/*.html')
for f in html_files:
    if os.path.basename(f) == 'developers.html':
        continue
    process_html_file(f)

