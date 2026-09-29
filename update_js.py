import os
import glob
import re

def process_js_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Replacements
    content = re.sub(r'rcoin', 'USD', content, flags=re.IGNORECASE)
    content = re.sub(r'crypto', 'Stripe', content, flags=re.IGNORECASE)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

js_files = glob.glob('src/scripts/**/*.js', recursive=True)
for f in js_files:
    process_js_file(f)
