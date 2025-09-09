FROM node:18

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Set working directory
WORKDIR /app

# Copy package.json and install Node.js dependencies
COPY package.json ./
RUN npm install

# Copy requirements.txt and install Python dependencies
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8888

# Start the application
CMD ["npm", "start"]
