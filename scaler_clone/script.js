// Mobile hamburger toggle
const hamburger = document.getElementById('hamburger');
const mobileNav = document.getElementById('mobile-nav');
hamburger.addEventListener('click', () => {
  mobileNav.classList.toggle('open');
});

// Header shadow on scroll
const header = document.getElementById('site-header');
window.addEventListener('scroll', () => {
  if (window.scrollY > 50) {
    header.classList.add('shadow');
  } else {
    header.classList.remove('shadow');
  }
});

// IntersectionObserver for fade-in animation on sections
const sections = document.querySelectorAll('section');
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('fade-in');
    }
  });
}, { threshold: 0.5 });
sections.forEach((section) => {
  observer.observe(section);
});

// Stat counter animation
const stats = document.querySelectorAll('.stat-number');
stats.forEach((stat) => {
  const target = parseFloat(stat.innerText.replace(/[^0-9.]/g, ''));
  const suffix = stat.innerText.replace(/[0-9.]/g, '');
  let count = 0;
  const duration = 2000; // 2 seconds
  const startTime = performance.now();

  const updateCount = (currentTime) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const currentCount = Math.floor(progress * target);
    
    stat.innerText = currentCount.toLocaleString() + suffix;

    if (progress < 1) {
      requestAnimationFrame(updateCount);
    }
  };
  requestAnimationFrame(updateCount);
});

// Button ripple effect on click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('cta-btn')) {
    const ripple = document.createElement('span');
    ripple.classList.add('ripple');
    e.target.appendChild(ripple);
    setTimeout(() => {
      ripple.remove();
    }, 500);
  }
});
