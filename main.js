document.addEventListener('DOMContentLoaded', () => {
    // 1. Mousemove Parallax for Prism Cubes
    const heroSection = document.querySelector('.hero-section');
    const cubes = document.querySelectorAll('.prism-cube');

    if (heroSection) {
        document.addEventListener('mousemove', (e) => {
            const xAxis = (window.innerWidth / 2 - e.pageX) / 25;
            const yAxis = (window.innerHeight / 2 - e.pageY) / 25;

            cubes.forEach((cube, index) => {
                const depth = (index + 1) * 0.5;
                cube.style.transform = `translate(${xAxis * depth}px, ${yAxis * depth}px) rotate(${index * 15}deg)`;
            });
        });

        // Reset transform on mouse leave
        document.addEventListener('mouseleave', () => {
            cubes.forEach((cube, index) => {
                cube.style.transform = `translate(0px, 0px) rotate(${index * 15}deg)`;
            });
        });
    }

    // 2. Click Logic for Glassmorphism Panel
    const overlayBtn = document.getElementById('runinback-overlay-btn');
    const glassPanel = document.getElementById('glass-panel');

    if (overlayBtn && glassPanel) {
        overlayBtn.addEventListener('click', () => {
            glassPanel.classList.add('active');
            overlayBtn.style.opacity = '0'; // Hide the button after clicking
        });
    }

    // 3. IntersectionObserver for Terminal Typing Animation
    const terminalCode = document.getElementById('terminal-code-content');
    if (terminalCode) {
        const textToType = terminalCode.innerHTML;
        terminalCode.innerHTML = ''; // Clear it out initially
        let isTyping = false;

        const typeWriter = (text, i, cb) => {
            if (i < text.length) {
                // simple typing loop handling HTML entities safely enough for this mock
                terminalCode.innerHTML = text.substring(0, i + 1);
                setTimeout(() => {
                    typeWriter(text, i + 1, cb);
                }, 15); // ms per char
            } else {
                if (typeof cb === 'function') cb();
            }
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !isTyping) {
                    isTyping = true;
                    typeWriter(textToType, 0);
                }
            });
        }, { threshold: 0.5 });

        observer.observe(terminalCode);
    }
});