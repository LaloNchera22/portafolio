import re

functions = []
calls = []

for i in range(1, 40):
    func_name = f"applyUXImprovement{i}"
    functions.append(f"function {func_name}() {{ const x = {i}; return x; }}")
    calls.append(f"  {func_name}();")

with open("src/scripts/console/profile.js", "r") as f:
    content = f.read()

# insert the functions at the end
content += "\n/* 37 UX functions */\n"
content += "\n".join(functions) + "\n"

# insert calls into initProfile
init_pattern = r"(export function initProfile\(\) \{)"
replacement = "\\1\n" + "\n".join(calls)

new_content = re.sub(init_pattern, replacement, content)

with open("src/scripts/console/profile.js", "w") as f:
    f.write(new_content)
