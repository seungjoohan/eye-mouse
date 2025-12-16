"""
Simple script to create placeholder icons for the extension.
Run this script to generate icon16.png, icon48.png, and icon128.png
"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, filename):
    # Create image with blue background
    img = Image.new('RGB', (size, size), color='#0096FF')
    draw = ImageDraw.Draw(img)

    # Draw an eye symbol
    eye_color = 'white'

    # Eye outline (ellipse)
    eye_width = int(size * 0.6)
    eye_height = int(size * 0.3)
    x = (size - eye_width) // 2
    y = (size - eye_height) // 2
    draw.ellipse([x, y, x + eye_width, y + eye_height],
                 outline=eye_color, width=max(2, size//32), fill='#0077CC')

    # Pupil (circle)
    pupil_size = int(size * 0.15)
    px = (size - pupil_size) // 2
    py = (size - pupil_size) // 2
    draw.ellipse([px, py, px + pupil_size, py + pupil_size], fill=eye_color)

    # Save
    script_dir = os.path.dirname(os.path.abspath(__file__))
    img.save(os.path.join(script_dir, filename))
    print(f"Created {filename}")

if __name__ == '__main__':
    create_icon(16, 'icon16.png')
    create_icon(48, 'icon48.png')
    create_icon(128, 'icon128.png')
    print("All icons created successfully!")
